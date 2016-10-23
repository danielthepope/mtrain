var bodyParser = require('body-parser')
var express = require('express');
var extend = require('extend');
var fs = require('fs');
var https = require('https');
var mongoose = require('mongoose');
var Nexmo = require('nexmo');
var NodeCache = require('node-cache');
var pug = require('pug');
var requester = require('request');
var uaParser = require('ua-parser-js');
var util = require('util');
var config = require('./src/trntxtconfig.js');
var iconGenerator = require('./src/iconGenerator.js');
var schema = require('./src/mongoSchemas.js')(mongoose);
var nr = require('./src/nationalrail.js');
var stt = require('./src/speechtotext.js');

var cache = new NodeCache({stdTTL: 60, checkperiod: 100});
var nexmo = new Nexmo({
  apiKey: config.nexmoApiKey,
  apiSecret: config.nexmoApiSecret,
  applicationId: config.nexmoApplicationId,
  privateKey: config.nexmoPrivateKeyPath
});
var app = express();
mongoose.connect(config.dbString);
var db = mongoose.connection;
var connected = false;
var Hit = null;
db.on('error', console.error.bind(console, 'connection error:'));
db.once('open', function (callback) {
  Hit = mongoose.model('trntxt_hits', schema.hit);
  connected = true;
  console.log('Database models initialised');
});
app.use( bodyParser.json() );       // to support JSON-encoded bodies
app.use(bodyParser.urlencoded({     // to support URL-encoded bodies
  extended: true
}));

var pugOptions = { doctype: 'html' };
var pugGlobals = { pageTitle: 'trntxt' };

function compile(locals) {
  var fn = pug.compileFile('resources/template.pug', pugOptions);
  return fn(extend({}, pugGlobals, locals));
}

function getStationsFromRequest(request) {
  var output = {};
  var errors = [];
  output.didYouMean = {
    from: [],
    to: []
  };
  if (request.params.from !== undefined) {
    var results = nr.findStation(request.params.from);
    if (results.length > 0) {
      output.fromStation = results[0];
      output.didYouMean.from = results.slice(1).filter(function (otherMatch) {
        return results[0].biggestChunk === otherMatch.biggestChunk;
      });
    } else {
      errors.push(request.params.from);
    }
  }
  if (request.params.to !== undefined) {
    var results = nr.findStation(request.params.to);
    if (results.length > 0) {
      output.toStation = results[0];
      output.didYouMean.to = results.slice(1).filter(function (otherMatch) {
        return results[0].biggestChunk === otherMatch.biggestChunk;
      });
    } else {
      errors.push(request.params.to);
    }
  }
  if (errors.length === 0) return output;
  else {
    output = "Invalid station name";
    if (errors.length > 1) output += "s: ";
    else output += ": ";
    errors.forEach(function (name) {
      output += name + ", ";
    });
    output = output.replace(/, $/, "");
    throw output;
  }
}

app.all('*', function(request, response, next) {
  console.log(request.method + " " + request.url);
  console.log(request.body);
  next();
})

app.get('/defaultsite', function (request, response) {
  response.sendFile('index.html', { root: './public' });
});

app.get('/d', function (request, response) {
  var from = request.query.from;
  var to = request.query.to;
  if (from) from = from.replace(/\W/g, '');
  if (to) to = to.replace(/\W/g, '');
  if (from) {
    if (to) {
      response.redirect('/' + from + '/' + to);
    } else {
      response.redirect('/' + from);
    }
  } else {
    response.redirect('/');
  }
});

// Regex matches letters (no dots), ? means 'to' is optional
app.get('/:from(\\w+)/:to(\\w+)?', function (request, response) {
  var stations = {};
  var locals = {};
  var uaString = request.headers['user-agent'];
  locals.agent = uaParser(uaString);
  locals.url = request.originalUrl;
  try {
    stations = getStationsFromRequest(request);
  } catch (e) {
    locals.errorMessage = e;
    return response.send(compile(locals));
  }

  locals.stationCodePath = '/' + stations.fromStation.stationCode + '/';
  if (stations.toStation) locals.stationCodePath += stations.toStation.stationCode + '/';
  locals.didYouMean = stations.didYouMean;

  if (connected && uaString !== 'AlwaysOn') {
    // Hit object may not have been loaded yet. Let's not make a fuss if it isn't.
    // Also Azure pings with 'AlwaysOn'. We don't need to save that.
    var hit = new Hit({
      agent: locals.agent,
      url: request.originalUrl,
      fromStation: stations.fromStation
    });
    if (stations.toStation) {
      hit.toStation = stations.toStation;
    }
    hit.save(function (err) {
      if (err) console.error("It didn't save. Meh");
      else console.log("Hit saved :)");
    });
  }

  nr.getDepartures(stations, function (output) {
    console.log(output)
    response.send(compile(extend({}, locals, output)));
  });
});

app.get('/details/:serviceId', function (request, response) {
  nr.getServiceDetails(request.params.serviceId, function (data) {
    console.log(data);
    response.send(data);
  });
});

app.get('/:from(\\w+)/:to(\\w+)?/:image(*.png)', function (request, response) {
  var from = request.params.from;
  var to = request.params.to;
  if ((from && from.length > 3) || (to && to.length > 3)) {
    return response.sendStatus(403);
  }
  var image = iconGenerator.getIcon(request.params.from, request.params.to, request.params.image);
  response.sendFile(image, { root: './' });
});

app.get('/favicon-16x16.png', function (request, response) {
  response.sendFile('favicon-16x16.png', { root: './public' });
});

app.get('*/manifest.json', function (request, response) {
  var manifest = {};
  var path = request.originalUrl.split('manifest.json')[0];

  manifest.lang = 'en';
  manifest.name = 'trntxt';
  manifest.short_name = 'trntxt';
  manifest.start_url = path;
  manifest.display = 'browser';
  manifest.icons = [];
  var resolutions = ['36', '48', '72', '96', '144', '192'];
  var densities = ['0.75', '1.0', '1.5', '2.0', '3.0', '4.0'];
  for (var i = 0; i < 6; i++) {
    var icon = {};
    icon.src = path + 'android-chrome-' + resolutions[i] + 'x' + resolutions[i] + '.png';
    icon.sizes = resolutions[i] + 'x' + resolutions[i];
    icon.type = 'image/png';
    icon.density = densities[i];
    manifest.icons.push(icon);
  }

  response.format({
    json: function () {
      response.send(manifest);
    }
  });
});

app.get('/:image(*.png)', function (request, response) {
  var image = iconGenerator.getIcon('TRN', 'TXT', request.params.image);
  response.sendFile(image, { root: './' });
});

app.get('*/browserconfig.xml', function (request, response) {
  var pugOptions = { pretty: true };
  var fn = pug.compileFile('resources/browserconfig.pug', pugOptions);
  var locals = { path: '/' };
  var urlElements = request.originalUrl.split('/');
  urlElements.forEach(function (element) {
    if (element !== 'browserconfig.xml' && element !== '') {
      var results = nr.findStation(element);
      if (results.length > 0) {
        locals.path += results[0].stationCode + '/';
      }
    }
  });
  response.format({
    'application/xml': function () {
      response.send(fn(locals));
    }
  });
});

app.get('/call.json', function (request, response) {
  response.sendFile('call.json', { root: './public' });
});

app.post('/', function (request, response) {
  if (request.body.from && request.body.conversation_uuid) {
    cache.set(request.body.conversation_uuid, request.body.from);
  }
})

app.post('/c/recording', function (request, response) {
  var jwt = nexmo.credentials.generateJwt();
  console.log(jwt);
  console.log(request.body.recording_url);

  var filename = 'resources/recordings/' + request.body.recording_uuid;

  var file = fs.createWriteStream(filename);

  var options = {
    hostname: 'api.nexmo.com',
    port: 443,
    path: request.body.recording_url.split('nexmo.com')[1],
    method: 'GET',
    headers: {
      'Authorization': 'Bearer ' + jwt
    }
  };
  
  var req = https.request(options, (res) => {
    console.log(`STATUS: ${res.statusCode}`);
    console.log(`HEADERS: ${JSON.stringify(res.headers)}`);
    var stream = res.pipe(file);
    stream.on('finish', function() {
      console.log('Got wav? ' + filename);
      stt.speechToText(filename, function(err, text) {
        if (err) return console.log(err);
        var sendTo = cache.get(request.body.conversation_uuid);
        var stationNames = stt.findStations(text);
        var fromStations = nr.findStation(stationNames.from);
        var fromStation = undefined;
        if (fromStations.length > 0) fromStation = fromStations[0];
        var toStations = nr.findStation(stationNames.to);
        var toStation = undefined;
        if (toStations.length > 0) toStation = toStations[0];
        nr.getDepartures({toStation, fromStation}, function (output) {
          console.log(output);
          nexmo.message.sendSms('trntxt', sendTo, generateSmsMessage(output, text));
        });
      })
    })
  });

  function generateSmsMessage(nrResults, dictation) {
    if (nrResults && nrResults.departureObject && nrResults.departureObject.trainServices && nrResults.departureObject.trainServices.length > 0) {
      var dep = nrResults.departureObject;
      var text = `The next train to ${dep.toStation.stationName} from ${dep.fromStation.stationName} will be the ${dep.trainServices[0].std}${dep.trainServices[0].etd === 'On time' ? '' : ' (expected ' + dep.trainServices[0].etd + ')'}${dep.fromStation.stationName === dep.trainServices[0].originStation.stationName ? '' : ' to ' + dep.trainServices[0].originStation.stationName}${dep.trainServices[0].platform ? ' from platform ' + dep.trainServices[0].platform : ''}.`;
      if (dep.trainServices.length > 1) {
        text += ' Also,'
        dep.trainServices.slice(1,3).forEach(function(service, index, array) {
          text += ` ${service.std}${service.etd === 'On Time' ? '' : ' (expected ' + service.etd + ')'} to ${service.originStation.stationName}${service.platform ? ', P' + service.platform : ''}${index+1 === array.length ? '.' : ';'}`;
        })
      }
      return text;
    } else {
      return `I heard "${dictation}". I couldn't find any services.`;
    }

  }

  req.on('error', (e) => {
    console.log(`problem with request: ${e.message}`);
  });

  // write data to request body
  req.end();

  response.sendStatus(200);
})

app.use(express.static('public'));

var server = app.listen(config.port, function () {
  console.log('listening on port %s', config.port);
});
