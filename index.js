"use strict";

var path = require('path');
var fs = require('fs');
var compiler = require('./compiler');

/**
 * @param {String} source
 */
module.exports = function (source) {
  // let webpack know about us, and get our callback
  var callback = this.async();

  var _this = this;
  var resourcePath = path.dirname(this.resourcePath);

  function resolver(file, cb) {
    const filepath = path.join(resourcePath, file);
    fs.stat(path.join(resourcePath, file), (err, stat) => {
      if (err || !stat.isFile()) {
        return cb(null);
      }
      cb(filepath);
    });
  }

  resolver.addDependency = function (file) {
    _this.addDependency(file);
  };

  compiler(resolver, source, function (contents) {
    callback(null, contents);
  });
};
