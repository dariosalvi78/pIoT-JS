//based on https://itp.nyu.edu/physcomp/labs/labs-serial-communication/lab-serial-communication-with-node-js/
var serialport = require("serialport");
var servi = require('servi');
var files = require('fs');
var logger = require('winston');

logger.add(logger.transports.File, { filename: 'logfile.log' });
logger.handleExceptions();
logger.exitOnError = false;
logger.info('starting piot node server');

var SerialPort = serialport.SerialPort;
var currentPort = null;
var serialBuffer = [];

//databases of all data
var dbs = [];
//database of the nodes
var nodesdb = null;

var app = new servi(false);
app.port(9090);

app.serveFiles("html");     // serve static HTML from public folder
app.route('/serials', listserials);
app.route('/serials/current', serveserial);
app.route('/logs', serveLogs);

app.route('/messagetypes', serveMessagetypes);
app.route('/nodes', serveNodes);
app.route('/messages', serveMessages);

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
     logger.log('debug', 'got data on '+currentPort.path+' '+ data);
      if(serialBuffer.length > 20)
        serialBuffer.shift();
      serialBuffer.push(data);
      try{
        storeData(JSON.parse(data));
      } catch(e) {
        logger.error('cannot parse '+data, e);
      }
   });
   currentPort.on('close', function() {
     logger.info('serial port closed');
   });
   currentPort.on('error', function(error) {
     logger.error('serial port error', error);
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
      request.respond(JSON.stringify(err));
    } else {
      request.header("application/json");
      request.respond(JSON.stringify(results));
    }
  });
}

function initDBs(){
  nodesdb = useDatabase('nodesdb');

  var names = files.readdirSync('./');
  for(var i in names){
    var filename = names[i];
    var ext = filename.split('.').pop();
    var pre = filename.substring(0,filename.lastIndexOf('.'));
    if(ext.toLowerCase() === 'db'){
      logger.info('loading DB '+filename);
      if(pre !== 'nodesdb'){
        dbs[pre] = useDatabase(pre);
        app.route('/messages/'+pre, serveMessages);
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
    logger.error('error from base', obj);
  } else {
    if(dbs[name] === undefined){
      logger.info('creating db for ' + name + ' and a new REST route');
      dbs[name] = useDatabase(name);
      app.route('/messages/'+name, serveMessages);
    }
    logger.log('debug', 'storing a ' + name, content);
    dbs[name].add(content);

    nodesdb.findOne({ sourceAddress: content.sourceAddress }, function(err, docs){
      if((docs === null) || (docs.length === 0)){
        logger.info('found a new node, address: '+content.sourceAddress);
        nodesdb.add({ name : null, location: null, sourceAddress: content.sourceAddress });
      }
    });
  }
}

function serveMessages(request){
  var skip =0, limit=10;
  if(request.params['skip'] !== undefined)
    skip = request.params['skip'];
  if(request.params['limit'] !== undefined)
    limit = request.params['limit'];

  if(request.path.split('/').length>2){
    //one datatype specified
    var dataname = request.path.split('/')[2];
    dataname = dataname.slice(0, dataname.lastIndexOf('?'));

    dbs[dataname].find({}).sort({ timestamp: -1 }).skip(skip).limit(limit).exec(function(err, docs){
      //add dataname
      var rr =[];
      for(var i= 0; i<docs.length; i++){
        rr[i] = {};
        rr[i][dataname] = docs[i];
      }
      request.header("application/json");
      request.respond(JSON.stringify(rr));
    });
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
        dbs[idx].find({}).sort({ timestamp: -1 }).limit(skip * limit).exec(function(err, docs){
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
  nodesdb.getAll(function(data){
    request.header("application/json");
    request.respond(JSON.stringify(data));
  });
}


initDBs();
app.start();
