[![Stories in Ready](https://badge.waffle.io/dariosalvi78/pIoT-JS.png?label=ready&title=Ready)](https://waffle.io/dariosalvi78/pIoT-JS)
# pIoT-JS
pico/personal Internet of Things, a javascript server that collects data from pIoT nodes, shows plots and runs rules

This code is used for getting data from pIoT nodes, visualising it and running rules.
It's Javascript code that can run on [nodeJS](https://nodejs.org/).
It includes a database, a web server and a web interface.
Messages are exchaned with the base using this format: `{ 'dataName': { a JSON message } }`, where dataName is the type of data is beign exchanged. For example: `{ 'lightMessage': { 'intensity': 300, 'on': true }}`.
The dataName is neede to understand how to interpret the rest of the message.

## Prerequisites

You need to install these packages to run the sever:

- serialport (npm install serialport)
- servi (npm install servi)
- winston (npm install winston)

you can also load all dependencies by calling `npm install`

## Run

call `node piot.js`
