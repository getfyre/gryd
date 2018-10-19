var Express = require('./express');
var GrydDocs = require('gryd-docs');
var Bunyan = require('bunyan');
var bformat = require('bunyan-format');
var formatOut = bformat({outputMode: 'short'});
var fs = require('fs');
var async = require('async');
var Promise = require('bluebird');
Promise.config({cancellation: true});
var bodyParser = require('body-parser');

var Application = module.exports = function (name, path, gryd, httpServer) {
    let loggerName = `${name}.${gryd.env}`;
    if (gryd.forkNum || gryd.forkNum === 0) {
        loggerName += `.${gryd.forkNum}`;
    }

    this.log = Bunyan.createLogger({name: loggerName, stream: formatOut, level: 'info'});
    this.name = name;
    this.path = path;
    this.gryd = gryd;
    this.httpServer = httpServer;
    this.app = null;
    this.db = null;
    this.config = null;

};

Application.prototype.initWorker = function (callback) {
    var self = this;
    async.series([
        self.loadConfig.bind(self),
        self.connectDatabase.bind(self),
        self.loadApp.bind(self),
        self.loadModels.bind(self),
        self.loadControllers.bind(self)
    ], function (err) {
        if (err) {
            callback(err);
        } else {
            callback(null, self);
        }
    });
};

Application.prototype.initMaster = function (callback) {
    var self = this;
    async.series([
        self.loadConfig.bind(self),
        self.connectDatabase.bind(self),
        self.loadModels.bind(self),
        self.startDaemons.bind(self)
    ], function (err) {
        if (err) {
            callback(err);
        } else {
            self.log.info("Application " + self.name + " active");
            callback(null, self);
        }
    });
};

Application.prototype.loadConfig = function (callback) {
    var self = this;
    var env = self.gryd.env;

    fs.access(self.path + "/config/" + env + ".js", function(err) {
        if (!err) {
            self.config = require(self.path + "/config/" + env);
            if (self.config.requestLog) {
                self.app.use(self.logRequest.bind(self));
            }

            // Sets the logger level depending on environment configs
            let level = self.config.loggerLevel || 'info';
            self.log.level(level);
            self.log.debug('Bunyan logger set at level: ' + level);

            self.log.debug('Running GRYD DEV');

            callback();
        } else {
            callback("Configuration for environment " + env + " does not exist");
        }
    });
};

Application.prototype.connectDatabase = function (callback) {
    var self = this;
    if (self.config.db) {
        var mongoose = require('mongoose');
        mongoose.Promise = Promise;
        //mongoose.connect(self.config.db);
        var opts = {
            keepAlive: 1,
            connectTimeoutMS: 30000,
            connectWithNoPrimary: true,
            poolSize: (self.gryd && parseInt(self.gryd.mongoosePoolSize)) || 5,
            // useNewUrlParser: true
        };

        self.log.debug('DB: ' + self.config.db);

        var connected = false;
        var attempts = 0;
        var MAX_ATTEMPTS = 10;
        connect();

        function connect() {
            attempts++;
            var db = mongoose.createConnection(self.config.db, opts);

            db.on('error', handleError);
            setTimeout(() => handleError('timeout'), 10000); // time out and retry after 10 seconds

            function handleError(err) {
                if (connected) {
                    return;
                }

                if (!/replica|timeout/i.test(err)) {
                    return callback(err);
                }

                setTimeout(() => {
                    if (connected) {
                        return;
                    } else if (attempts > MAX_ATTEMPTS) {
                        callback(err);
                    } else {
                        self.log.warn(`Error connecting to database ${err}. Retrying...`);
                        connect();
                    }
                }, 2000);
            }

            db.once('open', function () {
                if (connected) {
                    // on the off chance that a retried connection goes through, don't do anything if we connect twice
                    return;
                }

                self.log.info(`mongoose connection open after ${attempts} attempt${attempts > 1 ? 's' : ''}`);
                connected = true;
                db.Schema = mongoose.Schema;
                self.db = db;
                callback();
            });
        }


        //mongoose.connect(self.config.db, opts, function (err) {
        //    if (err) {
        //        self.log.warn(err);
        //    }
        //    var db = mongoose.connection;
        //    self.log.debug('mongoose connection open');
        //    db.Schema = mongoose.Schema;
        //    self.db = db;
        //    callback()
        //})


    } else {
        callback();
    }
};

Application.prototype.loadApp = function (callback) {
    var self = this;
    fs.access(self.path + "/index.js", function(err) {
        if (!err) {
            if (self.config.grydDocs) {
                self.config.grydDocs.basePath = "/" + self.name;
                Express = GrydDocs(Express, self.config.grydDocs);
            }
            self.app = Express();
            self.app.disable('x-powered-by');
            self.app.use(bodyParser.json({limit: '50mb'}));
            self.app.use(bodyParser.urlencoded({limit: '50mb', extended: true}));
            require(self.path)(self);
        }
        callback();
    });
};

Application.prototype.loadModels = function (callback) {
    var self = this;
    if (self.db) {
        fs.readdir(self.path + "/models", function (err, files) {
            if (err) {
                callback(err);
            } else {
                files = stripHiddenFiles(files);
                for (var i in files) {
                    var model_name = files[i];
                    require(self.path + "/models/" + model_name)(self);
                }
                callback();
            }
        });
    } else {
        callback();
    }
};

Application.prototype.loadControllers = function (callback) {
    var self = this;
    fs.readdir(self.path + "/controllers", function (err, files) {
        if (err) {
            callback(err);
        } else {
            files = stripHiddenFiles(files);
            for (var i in files) {
                var controller_name = files[i];
                var Controller = require(self.path + "/controllers/" + controller_name);
                new Controller(self);
            }
            callback();
        }
    });
};

Application.prototype.startDaemons = function (callback) {
    var self = this;
    fs.access(self.path + "/daemon.js", function (err) {
        if (!err) {
            require(self.path + "/daemon.js")(self);
            callback();
        }
    });
};

Application.prototype.logRequest = function (req, res, next) {
    var self = this;
    self.log.info("[" + getClientIp(req) + "] " + req.method + " " +
        req.hostname + req.originalUrl);
    next();
};

function getClientIp(req) {
    var ipAddress;
    var forwardedIpsStr = req.header('x-forwarded-for');
    if (forwardedIpsStr) {
        ipAddress = forwardedIpsStr.split(',')[0];
    }
    if (!ipAddress) {
        ipAddress = req.connection.remoteAddress;
    }
    return ipAddress;
}

function stripHiddenFiles(files) {
    var stripped = [];
    for (var i in files) {
        if (files[i].indexOf(".") != 0) {
            stripped.push(files[i]);
        }
    }
    return stripped;
}
