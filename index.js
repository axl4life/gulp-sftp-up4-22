"use strict";
const path = require("path"),
  fs = require("fs"),
  util = require("util"),
  Stream = require("stream"),
  through = require("through2"),
  Connection = require("ssh2"),
  assign = require("object-assign"),
  PluginError = require("plugin-error"),
  log = require("fancy-log"),
  colors = require("ansi-colors"),
  async = require("async"),
  parents = require("parents");

module.exports = function (options) {
  options = assign({}, options); // credit sindresorhus

  if (options.host === undefined) {
    throw new PluginError("gulp-sftp", "`host` required.");
  }

  let fileCount = 0,
    remotePath = options.remotePath || "/",
    remotePlatform = options.remotePlatform || options.platform || "unix";

  options.authKey = options.authKey || options.auth;
  let authFilePath = options.authFile || ".ftppass",
    authFile = path.join("./", authFilePath);

  if (options.authKey && fs.existsSync(authFile)) {
    let auth = JSON.parse(fs.readFileSync(authFile, "utf8"))[options.authKey];
    if (!auth) this.emit("error", new PluginError("gulp-sftp", "Could not find authkey in .ftppass"));
    if (typeof auth == "string" && auth.indexOf(":") != -1) {
      const authParts = auth.split(":");
      auth = { user: authParts[0], pass: authParts[1] };
    }
    for (let attr in auth) {
      options[attr] = auth[attr];
    }
  }

  //option aliases
  options.password = options.password || options.pass;
  options.username = options.username || options.user || "anonymous";

  /*
   * Lots of ways to present key info
   */
  let key = options.key || options.keyLocation || null;
  if (key && typeof key == "string") key = { location: key };

  //check for other options that imply a key or if there is no password
  if (!key && (options.passphrase || options.keyContents || !options.password)) {
    key = {};
  }

  if (key) {
    //aliases
    key.contents = key.contents || options.keyContents;
    key.passphrase = key.passphrase || options.passphrase;

    //defaults
    key.location = key.location || ["~/.ssh/id_rsa", "/.ssh/id_rsa", "~/.ssh/id_dsa", "/.ssh/id_dsa"];

    //type normalization
    !Array.isArray(key.location) && (key.location = [key.location]);

    //resolve all home paths
    if (key.location) {
      const home = process.env.HOME || process.env.USERPROFILE;

      for (const keyLocation of key.location)
        keyLocation.substr(0, 2) === "~/" && (keyLocation = path.resolve(home, keyLocation.replace(/^~\//, "")));

      for (let i = 0, keyPath; (keyPath = key.location[i++]); ) {
        if (fs.existsSync(keyPath)) {
          key.contents = fs.readFileSync(keyPath);
          break;
        }
      }
    } else if (!key.contents) this.emit("error", new PluginError("gulp-sftp", "Cannot find RSA key, searched: " + key.location.join(", ")));
  }
  /*
   * End Key normalization, key should now be of form:
   * {location:Array,passphrase:String,contents:String}
   * or null
   */

  const logFiles = options.logFiles === false ? false : true;

  delete options.remotePath;
  delete options.localPath;
  delete options.user;
  delete options.pass;
  delete options.logFiles;

  const mkDirCache = {};

  let finished = false,
    sftpCache = null, //sftp connection cache
    connectionCache = null; //ssh connection cache

  const pool = (remotePath, uploader) => {
    // method to get cache or create connection

    if (sftpCache) return uploader(sftpCache);

    if (options.password) log("Authenticating with password.");
    else if (key) log("Authenticating with private key.");

    const c = new Connection();
    connectionCache = c;
    c.on("ready", () => {
      c.sftp(function (err, sftp) {
        if (err) throw err;

        sftp.on("end", function () {
          log("SFTP :: SFTP session closed");
          sftpCache = null;
          if (!finished) this.emit("error", new PluginError("gulp-sftp", "SFTP abrupt closure"));
        });

        sftpCache = sftp;
        uploader(sftpCache);
      }); //c.sftp
    }); //c.on('ready')

    const self = this;

    c.on("error", (err) => self.emit("error", new PluginError("gulp-sftp", err))); //return cb(err);

    c.on("end", () => log("Connection :: end"));

    c.on("close", (err) => {
      if (!finished) {
        log("gulp-sftp", "SFTP abrupt closure");
        self.emit("error", new PluginError("gulp-sftp", "SFTP abrupt closure"));
      }
      if (err) log("Connection :: close, ", gutil.colors.red("Error: " + err));
      else log("Connection :: closed");
    });

    /*
     * connection options, may be a key
     */
    const connection_options = {
      host: options.host,
      port: options.port || 22,
      username: options.username,
    };

    if (options.password) connection_options.password = options.password;
    else if (options.agent) {
      connection_options.agent = options.agent;
      connection_options.agentForward = options.agentForward || false;
    } else if (key) {
      connection_options.privateKey = key.contents;
      connection_options.passphrase = key.passphrase;
    }

    if (options.timeout) connection_options.readyTimeout = options.timeout;

    c.connect(connection_options);

    /*
     * end connection options
     */
  };

  return through.obj(
    (file, enc, cb) => {
      if (file.isNull()) {
        this.push(file);
        return cb();
      }

      // have to create a new connection for each file otherwise they conflict, pulled from sindresorhus
      const finalRemotePath = normalizePath(path.join(remotePath, file.relative));

      //connection pulled from pool
      pool.call(this, finalRemotePath, (sftp) => {
        /*
         *  Create Directories
         */

        //get dir name from file path
        const dirname = path.dirname(finalRemotePath);
        //get parents of the target dir

        var fileDirs = parents(dirname)
          .map(function (d) {
            return d.replace(/^\/~/, "~");
          })
          .map((p) => path.normalize(p));

        if (dirname.search(/^\//) === 0) {
          fileDirs = fileDirs.map((dir) => {
            if (dir.search(/^\//) === 0) {
              return dir;
            }
            return "/" + dir;
          });
        }

        //get filter out dirs that are closer to root than the base remote path
        //also filter out any dirs made during this gulp session
        fileDirs = fileDirs.filter((d) => {
          return d.length >= remotePath.length && !mkDirCache[d];
        });

        //while there are dirs to create, create them
        //https://github.com/caolan/async#whilst - not the most commonly used async control flow
        async.whilst(
          function () {
            return fileDirs && fileDirs.length;
          },
          (next) => {
            let d = fileDirs.pop();
            mkDirCache[d] = true;

            if (remotePlatform && remotePlatform.toLowerCase().indexOf("win") !== -1) {
              d = d.replace("/", "\\");
            }
            sftp.exists(d, (exist) => {
              if (!exist) {
                sftp.mkdir(d, { mode: "0755" }, (err) => {
                  //REMOTE PATH
                  if (err) log("SFTP Mkdir Error:", colors.red(err + " " + d));
                  else log("SFTP Created:", colors.green(d));

                  next();
                });
              } else {
                next();
              }
            });
          },
          () => {
            const stream = sftp.createWriteStream(finalRemotePath, {
              //REMOTE PATH
              flags: "w",
              encoding: null,
              mode: "0666",
              autoClose: true,
            });

            //var readStream = fs.createReadStream(fileBase+localRelativePath);

            let uploadedBytes = 0;

            const highWaterMark = stream.highWaterMark || 16 * 1000;
            const size = file.stat.size;

            // start upload (edit by Dan503 https://github.com/Dan503)
            if (file.isStream()) file.contents.pipe(stream);
            else if (file.isBuffer()) stream.end(file.contents);

            stream.on("drain", () => {
              uploadedBytes += highWaterMark;
              let p = Math.round((uploadedBytes / size) * 100);
              p = Math.min(100, p);
              log("gulp-sftp:", finalRemotePath, "uploaded", uploadedBytes / 1000 + "kb");
            });

            stream.on("close", (err) => {
              if (err) this.emit("error", new PluginError("gulp-sftp", err));
              else {
                if (logFiles) {
                  log("gulp-sftp:", gutil.colors.green("Uploaded: ") + file.relative + colors.green(" => ") + finalRemotePath);
                }

                fileCount++;
              }
              return cb(err);
            });
          }
        ); //async.whilst
      });

      this.push(file);
    },
    (cb) => {
      if (fileCount > 0) log("gulp-sftp:", colors.green(fileCount, fileCount === 1 ? "file" : "files", "uploaded successfully"));
      else log("gulp-sftp:", colors.yellow("No files uploaded"));

      finished = true;
      sftpCache && sftpCache.end();
      connectionCache && connectionCache.end();

      cb();
    }
  );
};
