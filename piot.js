//based on https://itp.nyu.edu/physcomp/labs/labs-serial-communication/lab-serial-communication-with-node-js/
var serialport = require("serialport");
var servi = require('servi');
var files = require('fs');

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

app.route('/messagetypes', serveMessagetypes);
app.route('/nodes', serveNodes);
app.route('/messages', serveMessages);

function listserials(request) {
  var resp = [];
  serialport.list(function (err, ports) {
    if(ports !== null){
      ports.every(function(port, index, array) {
        resp.push(port.comName);
        console.log("found port: "+port.comName);
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
       console.log("sending data to serial: "+request.fields['sendline']);
       currentPort.write(request.fields['sendline']);
       resp.name = currentPort.path;
       resp.buffer = serialBuffer;
    }
  }

  request.header("application/json");
  request.respond(JSON.stringify(resp));
}

function startSerial(name){
  console.log("opening "+name);
  currentPort = new SerialPort(name, {
     baudRate: 57600,
     // look for return and newline at the end of each data packet:
     parser: serialport.parsers.readline("\r\n")
   });
   currentPort.on('open', function() {
     console.log(name+' open');
   });
   currentPort.on('data', function(data) {
      console.log('Got data on '+currentPort.path+' '+ data);
      if(serialBuffer.length > 20)
        serialBuffer.shift();
      serialBuffer.push(data);
      try{
        storeData(JSON.parse(data));
      } catch(e) {
        console.log('cannot parse '+data+' : '+e.message);
      }

   });
   currentPort.on('close', function() {
      console.log('Serial port closed');
   });
   currentPort.on('error', function(error) {
      console.log('Serial port error: ' + error);
   });
}

function stopSerial(){
  if(currentPort !== null){
    currentPort.close();
    currentPort = null;
  }
}

function initDBs(){
  nodesdb = useDatabase('nodesdb');

  var names = files.readdirSync('./');
  for(var i in names){
    var filename = names[i];
    var ext = filename.split('.').pop();
    var pre = filename.substring(0,filename.lastIndexOf('.'));
    if(ext.toLowerCase() === 'db'){
      console.log('loading DB '+filename);
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
  if(dbs[name] === undefined){
    console.log('Creating db for ' + name + ' and a new REST route');
    dbs[name] = useDatabase(name);
    app.route('/messages/'+name, serveMessages);
  }
  console.log('storing a ' + name +': '+JSON.stringify(content));
  dbs[name].add(content);

  nodesdb.findOne({ sourceAddress: content.sourceAddress }, function(err, docs){
    if((docs === null) || (docs.length === 0)){
      console.log('found a new node, address: '+content.sourceAddress);
      nodesdb.add({ name : null, location: null, sourceAddress: content.sourceAddress });
    }
  });
}

function serveMessages(request){
  var skip =0, to=10;
  if(request.params['from'] !== undefined)
    skip = request.params['from'];
  if(request.params['to'] !== undefined)
    to = request.params['to'];

  if(request.path.split('/').length>2){
    //one datatype specified
    var dataname = request.path.split('/')[2];

    dataname = dataname.slice(0, dataname.lastIndexOf('?'));

    dbs[dataname].find({}).sort({ timestamp: -1 }).skip(skip).limit(to).exec(function(err, docs){
      request.header("application/json");
      request.respond(JSON.stringify(docs));
    });
  } else {
    //all datatypes
    var ret = [];
    var merge = function(left, right){
      var result  = [], il = 0, ir = 0;
      while (il < left.length && ir < right.length){
        if (left[il].timestamp > right[ir].timestamp){
          result.push(left[il++]);
        } else {
          result.push(right[ir++]);
        }
      }
      return result.concat(left.slice(il)).concat(right.slice(ir));
    }
    var iterate = function(idxs){
      if(idxs.length === 0){
        request.header("application/json");
        request.respond(JSON.stringify(ret.slice(skip, to)));
      } else {
        var idx = idxs.pop();
        dbs[idx].find({}).sort({ timestamp: -1 }).limit(to).exec(function(err, docs){
          //TODO: this is inefficient, we should skip some elements, the problem is: how many?
          ret = merge(ret, docs);
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
