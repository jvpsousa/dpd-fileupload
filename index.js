'use strict';

/**
 * Module dependencies
 */
var Resource   = require('deployd/lib/resource'),
    util       = require('util'),
    path       = require('path'),
    debug      = require('debug')('dpd-fileupload'),
    formidable = require('formidable'),
    fs         = require('fs'),
    md5        = require('md5'),
    mime       = require('mime'),
    _          = require('lodash'),
    env        = process.server.options && process.server.options.env || null,
    publicDir  = "/../../public";

/**
 * Module setup.
 */
function Fileupload(options) {

    Resource.apply(this, arguments);

    this.store = process.server.createStore(this.name + "fileupload");

    if(env){
        var dirToCheck = publicDir + "-" + env,
        publicDirExists = fs.existsSync(__dirname + dirToCheck);
        if(publicDirExists) {
            publicDir = dirToCheck;
        }
    }

    this.config = {
        directory: this.config.directory || 'upload',
        fullDirectory: this.config.directory
    };

    if (this.name === this.config.directory) {
        this.config.directory = this.config.directory + "_";
    }

    // If the directory doesn't exists, we'll create it
    try {
        fs.statSync(this.config.fullDirectory).isDirectory();
    } catch (er) {
        // fs.mkdir(this.config.fullDirectory);
    }
}

util.inherits(Fileupload, Resource);

Fileupload.label = "File upload";
Fileupload.events = ["get", "upload", "delete"];
Fileupload.prototype.clientGeneration = true;
Fileupload.basicDashboard = {
    settings: [
        {
            name: 'directory',
            type: 'text',
            description: 'Directory to save the uploaded files. Defaults to \'upload\'.'
        }
    ]
};

/**
 * Module methods
 */
Fileupload.prototype.handle = function (ctx, next) {
    var req = ctx.req,
        self = this,
        domain = {url: ctx.url};

    if (req.method === "POST" || req.method === "PUT") {
        var form = new formidable.IncomingForm(),
            uploadDir = this.config.fullDirectory,
            resultFiles = [],
            remainingFile = 0,
            storedProperties = {},
            uniqueFilename = false,
            subdir;

        // Will send the response if all files have been processed
        var processDone = function(err) {
            if (err) return ctx.done(err);
            remainingFile--;
            if (remainingFile === 0) {
                debug("Response sent: ", resultFiles);
                return ctx.done(null, resultFiles);
            }
        };

        // If we received params from the request
        if (typeof req.query !== 'undefined') {
            for (var propertyName in req.query) {
                debug("Query param found: { %j:%j } ", propertyName, req.query[propertyName]);

                if (propertyName === 'subdir') {
                    debug("Subdir found: %j", req.query[propertyName]);
                    subdir = req.query[propertyName];
                    uploadDir = path.join(uploadDir, subdir);
                    // If the sub-directory doesn't exists, we'll create it
                    try {
                        fs.statSync(uploadDir).isDirectory();
                    } catch (er) {
                        fs.mkdir(uploadDir);
                    }

                } else if (propertyName === 'uniqueFilename') {
                    debug("uniqueFilename found: %j", req.query[propertyName]);
                    uniqueFilename = (req.query[propertyName] === 'true');
                    continue; // skip to the next param since we don't need to store this value
                }

                // Store any param in the object
                try {
                    storedProperties[propertyName] = JSON.parse(req.query[propertyName]);
                } catch (e) {
                    storedProperties[propertyName] = req.query[propertyName];
                }
            }
        }

        form.uploadDir = uploadDir;

        var renameAndStore = function(file) {
            fs.rename(file.path, path.join(uploadDir, file.name), function(err) {
                if (err) return processDone(err);
                debug("File renamed after event.upload.run: %j", err || path.join(uploadDir, file.name));
				var storedObject = _.clone(storedProperties);
                storedObject.filename = file.name;
                if (uniqueFilename) {
                    storedObject.originalFilename = file.originalFilename;
                }
                storedObject.filesize = file.size;
                storedObject.creationDate = new Date().getTime();

                // Store MIME type in object
                storedObject.type = mime.lookup(file.name);
                if (storedObject.id) delete storedObject.id;
                if (storedObject._id) delete storedObject._id;

                self.store.insert(storedObject, function(err, result) {
                    if (err) return processDone(err);
                    debug('stored after event.upload.run %j', err || result || 'none');
                    var cloneResult = _.clone(result);
                    resultFiles.push(cloneResult);
                    processDone();
                });

            });
        };

        form.parse(req)
            .on('file', function(name, file) {
                debug("File %j received", file.name);
                if (uniqueFilename) {
                    file.originalFilename = file.name;
                    file.name = md5(Date.now()) + '.' + file.name.split('.').pop();
                }
                if (self.events.upload) {
                    self.events.upload.run(ctx, {
                      url: ctx.url,
                      filesize: file.size,
                      filename: file.name,
                      originalFilename: file.originalFilename,
                      uniqueFilename: uniqueFilename,
                      subdir: subdir
                    }, function(err) {
                        if (err) return processDone(err);
                        renameAndStore(file);
                    });
                } else {
                    renameAndStore(file);
                }
            }).on('fileBegin', function(name, file) {
                remainingFile++;
                debug("Receiving a file: %j", file.name);
            }).on('error', function(err) {
                debug("Error: %j", err);
                return processDone(err);
            });
        return req.resume();
    } else if (req.method === "GET") {

		this.get(ctx, function(err, result) {
			if (err) return ctx.done(err);
			else if (self.events.get) {
				domain.data = result;
				domain['this'] = result;

				self.events.get.run(ctx, domain, function(err) {
					if (err) return ctx.done(err);
					ctx.done(null, result);
				});
			} else {
				ctx.done(err, result);
			}
		});

    } else if (req.method === "DELETE") {

        if (this.events['delete']) {
            this.events['delete'].run(ctx, domain, function(err) {
                if (err) return ctx.done(err);
                self.del(ctx, next);
            });
        } else {
            this.del(ctx, next);
        }
    } else {
        next();
    }
};


Fileupload.prototype.get = function(ctx, next) {
    var self = this;
	var id = ctx.url.split('/')[1];
	if (id.length > 0)
		ctx.query.id = id;

	self.store.find(ctx.query, next);
};

// Delete a file
Fileupload.prototype.del = function(ctx, next) {
    var self = this,
        fileId = ctx.url.split('/')[1],
        uploadDir = this.config.fullDirectory;

    this.store.find({id: fileId}, function(err, result) {
        if (err) return ctx.done(err);
        debug('found %j', err || result || 'none');
        if (typeof result !== 'undefined') {
            var subdir = "";
            if (result.subdir !== null) {
                subdir = result.subdir;
            }
            self.store.remove({id: fileId}, function(err) {
                if (err) return ctx.done(err);
                //Fixed in case you don't upload to a subdir
                if(subdir){
                    fs.unlink(path.join(uploadDir, subdir, result.filename), function(err) {
                        if (err) return ctx.done(err);
                        ctx.done(null, {statusCode: 200, message: "File " + result.filename + " successfuly deleted"});
                    });
                } else {
                    fs.unlink(path.join(uploadDir, result.filename), function(err) {
                        if (err) return ctx.done(err);
                        ctx.done(null, {statusCode: 200, message: "File " + result.filename + " successfuly deleted"});
                    });
                }
            });
        }
    });
};

/**
 * Module export
 */
module.exports = Fileupload;
