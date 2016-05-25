/**
 * Project Name: Gryd
 * Author: Aaron Blankenship
 * Date: 11-20-2014
 *
 * Copyright (c) 2014, Aaron Blankenship

 * Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee
 * is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE
 * INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE
 * FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
 * OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING
 * OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 *
 */
var cluster = require('cluster');
var cpus = require('os').cpus().length;
var fs = require('fs');
var Bunyan = require('bunyan');
var bformat = require('bunyan-format');
var formatOut = bformat({outputMode: 'short'});
var Express = require('./express');
var Application = require('./application');
var _ = require('lodash');

var grydconfig = {
    port: process.env.gryd_port || 8000,
    env: process.env.gryd_environment || "dev"
};
var level = (grydconfig.env === 'dev') ? 'debug' : 'info';
var Logger = Bunyan.createLogger({
    name: "GrydProcess." + grydconfig.env,
    stream: formatOut,
    level: level
});
Logger.info('Bunyan logger set at level: ' + level);
Logger.debug('debug check');

module.exports = function (app_path, gryd_opts) {
    if (gryd_opts) {
        grydconfig.port = gryd_opts.hasOwnProperty("port") ? gryd_opts.port : grydconfig.port;
        grydconfig.env = gryd_opts.hasOwnProperty("env") ? gryd_opts.env : grydconfig.env;
    }
    if (cluster.isMaster) {
        Logger.info({GrydConfig: grydconfig});
    }
    fs.readdir(app_path, function (err, files) {
        if (err) {
            if (cluster.isMaster)
                Logger.info("Application path does not exist " + app_path);
        } else {
            files = stripHiddenFiles(files);
            if (cluster.isMaster) {
                Logger.info("Starting daemons...");
                initialize(app_path, files, function (Apps) {
                    for (var i = 0; i < cpus; i++) {
                        cluster.fork();
                    }
                });
                Logger.info("Starting clustered applications...");
            } else {
                var GlobalApp = Express();
                GlobalApp.disable('x-powered-by');
                initialize(app_path, files, function (Apps) {
                    for (var i in Apps) {
                        var App = Apps[i];
                        GlobalApp.use("/" + App.name, App.app);
                    }
                    GlobalApp.listen(grydconfig.port);
                }, GlobalApp);
            }
        }
    });
};

function initialize(app_path, files, callback, GlobalApp) {
    var Apps = [];
    var finished = _.after(files.length, function () {
        callback(Apps);
    });
    for (var i in files) {
        var app_name = files[i];
        var path = app_path + "/" + app_name;
        var app = new Application(app_name, path, grydconfig, GlobalApp);
        if (cluster.isMaster) {
            app.initMaster(function (err, self) {
                if (err) {
                    Logger.error(err);
                } else {
                    Apps.push(self);
                    finished();
                }
            });
        } else {
            app.initWorker(function (err, self) {
                if (err) {
                    Logger.error(err);
                } else {
                    Apps.push(self);
                    finished();
                }
            });
        }
    }
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