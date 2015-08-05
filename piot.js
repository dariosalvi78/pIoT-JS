//based on https://itp.nyu.edu/physcomp/labs/labs-serial-communication/lab-serial-communication-with-node-js/
var serialport = require("serialport");
var servi = require('servi');
var files = require('fs');
var logger = require('winston');

logger.add(logger.transports.File, { filename: 'logfile.log' });
logger.handleExceptions();
logger.exitOnError = false;

var SerialPort = serialport.SerialPort;
var currentPort = null;
var serialBuffer = [];

//dbs are compacted every 10 minutes
var AUTOCOMPACT_INTERVAL = 10 * 60 * 1000;
//databases of all data
var dbs = [];
//database of the nodes
var nodesdb = null;
//database of the action examples
var actionsdb = null;


var app = new servi(false);
app.port(9090);

app.serveFiles("html");     // serve static HTML from public folder
app.route('/serials', listserials);
app.route('/serials/current', serveserial);
app.route('/logs', serveLogs);

app.route('/messagetypes', serveMessagetypes);
app.route('/nodes', serveNodes);
app.route('/nodes/:nodeAddress', serveNodes);
app.route('/messages', serveMessages);
app.route('/messages/:dataname', serveMessages);
app.route('/messages/:dataname/:messageid', serveMessages);
app.route('/actions', serveActions);
app.route('/plots/:dataname', servePlots);

function listserials(request) {
  var resp = [];
  serialport.list(function (err, ports) {
    if(ports !== null){
      ports.every(function(port, index, array) {
        resp.push(port.comName);
        logger.info("found port: "+port.comName);
      });
    }
    request.header("application/json");
    request.respond(JSON.stringify(resp));
  });
}

function serveserial(request) {
  var resp = {};
  if(request.method.toLowerCase() == "get"){
    if((currentPort !== null) && (currentPort.isOpen())){
      resp.name = currentPort.path;
      resp.buffer = serialBuffer;
    }
  } else if(request.method.toLowerCase() == "post"){
    if((request.fields['name'] !== undefined) && (currentPort === null)){
      resp.name = request.fields['name'];
      startSerial(request.fields['name']);
    }
    if((request.fields['name'] !== undefined) && (currentPort !== null) && (request.fields['name'] == '')){
      stopSerial();
    }

    if((request.fields['sendline'] !== undefined) && (currentPort !== null)){
      logger.log('debug', "sending data to serial: "+request.fields['sendline']);
      currentPort.write(request.fields['sendline']);
      resp.name = currentPort.path;
      resp.buffer = serialBuffer;
    }
  }

  request.header("application/json");
  request.respond(JSON.stringify(resp));
}

function startSerial(name){
  logger.info("opening port "+name);
  currentPort = new SerialPort(name, {
     baudRate: 57600,
     // look for return and newline at the end of each data packet:
     parser: serialport.parsers.readline("\r\n")
   });
   currentPort.on('open', function() {
     logger.info(name+' open');
   });
   currentPort.on('data', function(data) {
     if(serialBuffer.length > 20)
        serialBuffer.shift();
      serialBuffer.push(data);
      try{
        logger.info('received line on '+currentPort.path+': '+data);
        storeData(JSON.parse(data));
      } catch(e) {
        logger.error('cannot parse line: '+data+', cause: '+JSON.stringify(e));
      }
   });
   currentPort.on('close', function() {
     logger.info('serial port closed');
   });
   currentPort.on('error', function(error) {
     logger.error('serial port error: '+JSON.stringify(error));
   });
}

function stopSerial(){
  if(currentPort !== null){
    currentPort.close();
    currentPort = null;
  }
}

function serveLogs(request){
  logger.query({
    from: new Date - 24 * 60 * 60 * 1000,
    until: new Date,
    limit: 100,
    start: 0,
    order: 'desc',
  }, function (err, results) {
    if (err) {
      request.header("application/json");
      request.respond('Error: '+JSON.stringify(err));
    } else {
      request.header("application/json");
      request.respond(JSON.stringify(results));
    }
  });
}

function initDBs(){
  logger.info('loading nodes DB');
  nodesdb = useDatabase('nodesdb');
  //nodesdb.persistence.setAutocompactionInterval(AUTOCOMPACT_INTERVAL);
  actionsdb = useDatabase('actionsdb');
  //actionsdb.persistence.setAutocompactionInterval(AUTOCOMPACT_INTERVAL);

  var names = files.readdirSync('./');
  for(var i in names){
    var filename = names[i];
    var ext = filename.split('.').pop();
    var pre = filename.substring(0,filename.lastIndexOf('.'));
    if(ext.toLowerCase() === 'db'){
      logger.info('loading DB '+filename);
      if((pre !== 'nodesdb') && (pre !== 'actionsdb')){
        dbs[pre] = useDatabase(pre);
        //dbs[pre].persistence.setAutocompactionInterval(AUTOCOMPACT_INTERVAL);
      }
    }
  }
}

function storeData(obj){
  var name;
  for(var member in obj){
    name = member;
  }
  var content = obj[name];
  content.timestamp = new Date().getTime();
  if(name.toLowerCase() === 'error'){
    logger.error('error from base node: '+JSON.stringify(obj));
  } else {
    if(dbs[name] === undefined){
      logger.info('creating db for ' + name + ' and a new REST route');
      dbs[name] = useDatabase(name);
      app.route('/messages/'+name, serveMessages);
      app.route('/messages/'+name+'/:id', serveMessages);
    }
    logger.log('debug', 'storing a ' + name, content);
    dbs[name].add(content);

    nodesdb.findOne({ address: content.sourceAddress }, function(err, docs){
      if((docs === null) || (docs.length === 0)){
        logger.info('found a new node, address: '+content.sourceAddress);
        nodesdb.add({ name : null, location: null, address: content.sourceAddress });
      }
    });
  }
}

function serveMessages(request){
  if(request.method.toLowerCase() == "delete"){
    var dataname = request.params.dataname;
    var id = request.params.messageid;
    logger.info('deleting '+dataname+' id:'+id);
    dbs[dataname].remove({ _id: id }, {}, function (err, numRemoved) {
      if(err) request.respond(JSON.stringify(err));
      else request.respond('OK');
    });
  } else if(request.method.toLowerCase() == "get"){

    var skip =0, limit=10;
    var srcAddr = null;
    var fromdate = null;
    if(request.params['skip'] !== undefined)
    skip = parseInt(request.params['skip']);
    if(request.params['limit'] !== undefined)
    limit = parseInt(request.params['limit']);
    if((request.params['srcAddr'] !== undefined) &&
    (request.params['srcAddr'] !== ''))
    srcAddr = parseInt(request.params['srcAddr']);
    if((request.params['fromdate'] !== undefined) &&
    (request.params['fromdate'] !== ''))
    fromdate = parseInt(request.params['fromdate']);


    var filter = {};
    if(srcAddr !== null)
    filter.sourceAddress = srcAddr;
    if(fromdate !== null)
    filter.timestamp = {$lte : fromdate};

    if(request.params.dataname){
      //one datatype specified
      var dataname = request.params.dataname;
      if(request.params.messageid){
        //one specific message
        var id = request.params.messageid;
        dbs[dataname].findOne({ _id: id }, function(err, doc){
          var rr ={ };
          rr[dataname] = doc;
          request.header("application/json");
          request.respond(JSON.stringify(rr));
        });
      } else {
        dbs[dataname].find(filter).sort({ timestamp: -1 }).skip(skip).limit(limit).exec(function(err, docs){
          //add dataname
          var rr =[];
          for(var i= 0; i<docs.length; i++){
            rr[i] = {};
            rr[i][dataname] = docs[i];
          }
          request.header("application/json");
          request.respond(JSON.stringify(rr));
        });
      }
    } else {
      //all datatypes
      var ret = [];
      var merge = function(left, right){
        var result  = [], il = 0, ir = 0;
        while (il < left.length && ir < right.length){
          var ll = left[il];
          var rr = right[ir];
          if (ll[Object.keys(ll)[0]].timestamp > rr[[Object.keys(rr)[0]]].timestamp){
            result.push(ll);
            il++;
          } else {
            result.push(rr);
            ir++;
          }
        }
        return result.concat(left.slice(il)).concat(right.slice(ir));
      }
      var iterate = function(idxs){
        if(idxs.length === 0){
          ret = ret.slice(skip, limit);
          request.header("application/json");
          request.respond(JSON.stringify(ret));
        } else {
          var idx = idxs.pop();
          //TODO: this is inefficient, we should skip some elements, the problem is: how many?
          dbs[idx].find(filter).sort({ timestamp: -1 }).limit(skip * limit).exec(function(err, docs){
            //add dataname
            var dd = [];
            for(var i= 0; i<docs.length; i++){
              dd[i] = {};
              dd[i][idx] = docs[i];
            }
            ret = merge(ret, dd);

            iterate(idxs);
          });
        }
      };
      iterate(Object.keys(dbs));
    }
  }
}

function serveActions(request){
  if(request.method.toLowerCase() == "get"){
    actionsdb.getAll(function(data){
      request.header("application/json");
      request.respond(JSON.stringify(data));
    });
  } else if(request.method.toLowerCase() == "post"){
    var action = JSON.parse(request.fields['action']);
    var name;
    for(var member in action){
      name = member;
    }
    app.route('/actions/'+name, serveActions);
    logger.info('new action set ' + name);
    actionsdb.add(action);
    request.respond('OK');
  }
  else if(request.method.toLowerCase() == "delete"){
    var name = request.path.split('/')[2];
    logger.info('deleting action ' + name);
    var example = JSON.parse('{ "'+name+'": { "$exists": true } }');

    actionsdb.remove(example, { multi: true }, function(err, numReplaced, newDoc){
      if(err) request.respond(JSON.stringify(err));
      else request.respond("OK");
    });
  }
}

function servePlots(request){
  var end = new Date().getTime();//default value
  var start = new Date(end-24*60*60*1000).getTime();//default value
  var srcAddr = null;
  if(request.params['start'] !== undefined)
    start = parseInt(request.params['start']);
  if(request.params['end'] !== undefined)
    end = parseInt(request.params['end']);
  if((request.params['srcAddr'] !== undefined) &&
    (request.params['srcAddr'] !== ''))
    srcAddr = parseInt(request.params['srcAddr']);

  var filter = { timestamp: { $lte: end, $gte: start } };
  if(srcAddr !== null)
    filter.sourceAddress = srcAddr;

  var dataname = request.params.dataname.split('.')[0];
  var property = request.params.dataname.split('.')[1];

  dbs[dataname].find(filter).sort({ timestamp: -1 }).exec(function(err, docs){
    var ret =[];

    for(var i= 0; i<docs.length; i++){
      ret.unshift([docs[i].timestamp, docs[i][property]]);
    }
    request.header("application/json");
    request.respond(JSON.stringify(ret));
  });
}


function serveMessagetypes(request){
  var re = [];
  var acc = 0;
  var indexes = Object.keys(dbs);
  var iterate = function(idxs){
    if(idxs.length === 0){
      re.push({ name: 'all', count: acc });
      request.header("application/json");
      request.respond(JSON.stringify(re));
    } else {
      var idx = idxs.pop();
      dbs[idx].count(null, function(err, count){
        re.push({ name: idx, count: count });
        acc += count;
        iterate(idxs);
      });
    }
  };
  iterate(indexes);
}

function serveNodes(request){
  if(request.method.toLowerCase() == "get"){
    nodesdb.getAll(function(data){
      request.header("application/json");
      request.respond(JSON.stringify(data));
    });
  } else if(request.method.toLowerCase() == "post"){
    var addr = parseInt(request.params.nodeAddress);
    request.fields['address'] = parseInt(request.fields['address']);
    logger.info('updating node ' + addr+' to ' + JSON.stringify(request.fields));
    nodesdb.update({ address: addr }, request.fields, {}, function(err, numReplaced, newDoc){
      if(err){
        request.header("application/json");
        request.respond(JSON.stringify(err));
      } else {
        request.header("application/json");
        request.respond(JSON.stringify(request.fields));
      }
    });
  } else if(request.method.toLowerCase() == "delete"){
    var addr = parseInt(request.params.nodeAddress);
    logger.info('deleting node ' + addr + ' and all its data');
    nodesdb.remove({ address: addr }, { multi: true }, function(err, numReplaced, newDoc){
      if(err){
        request.header("application/json");
        request.respond(JSON.stringify(err));
      } else {
        //delete all data of this node
        for(dataname in dbs){
          console.log('deleting from '+dataname);
          dbs[dataname].remove({ sourceAddress: addr }, { multi: true }, function(err, numReplaced, newDoc){
            if(err){
              request.header("application/json");
              request.respond(JSON.stringify(err));
            } else request.respond('OK');
          });
        }
      }
    });
  }
}


logger.info('starting piot node server');
initDBs();
app.start();
