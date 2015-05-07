//based on https://itp.nyu.edu/physcomp/labs/labs-serial-communication/lab-serial-communication-with-node-js/
var serialport = require("serialport");
var servi = require('servi');

var SerialPort = serialport.SerialPort;
var currentPort = null;
var serialBuffer = [];

var app = new servi(false);
app.port(9090);

app.serveFiles("html");     // serve static HTML from public folder
app.route('/serials', listserials);
app.route('/serials/current', serveserial);

function listserials(request) {
  var resp = [];
  serialport.list(function (err, ports) {
    ports.every(function(port, index, array) {
      resp.push(port.comName);
      console.log("found port: "+port.comName);
    });
    request.header("application/json");
    request.respond(JSON.stringify(resp));
  });
}

function serveserial(request) {
  var resp = {};
  if(request.method.toLowerCase() == "get"){
    if(currentPort !== null){
      resp.name = currentPort.comName;
      resp.buffer = data;
    }
  } else if(request.method.toLowerCase() == "post"){
    if(request.fields['name'] !== undefined){
      resp.name = request.fields['name'];
      startSerial(request.fields['name']);
    } else stopSerial();

    if((request.fields['sendline'] !== undefined) && (currentPort !== null)){
       console.log("sending data to serial: "+request.fields['sendline']);
       currentPort.write(request.fields['sendline']);
       resp.name = currentPort.comName;
       resp.buffer = serialBuffer;
    }
  }

  request.header("application/json");
  request.respond(JSON.stringify(resp));
}

function startSerial(name){
  console.log("opening "+name);
  var currentPort = new SerialPort(name, {
     baudRate: 57600,
     // look for return and newline at the end of each data packet:
     parser: serialport.parsers.readline("\r\n")
   });
   currentPort.on('open', function() {
     console.log('port open');
   });
   currentPort.on('data', function(data) {
      console.log('Got data:' + data);
      if(serialBuffer.length > 20)
        serialBuffer.shift();
      serialBuffer.push(data);
   });
   currentPort.on('close', function() {
      console.log('port closed');
   });
   currentPort.on('error', function(error) {
      console.log('Serial port error: ' + error);
   });
}

function stopSerial(){
  if(currentPort !== null){
    currentPort.close();
  }
}


app.start();
