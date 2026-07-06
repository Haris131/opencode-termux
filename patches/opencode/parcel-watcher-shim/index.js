var fs = require("fs")
var path = require("path")

function matchesAny(filePath, patterns) {
  for (var i = 0; i < patterns.length; i++) {
    var p = patterns[i]
    if (typeof p === "string") {
      if (filePath === p || filePath.indexOf(p + "/") === 0) return true
      if (p.indexOf("*") !== -1) {
        var escaped = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
        if (new RegExp("^" + escaped + "$").test(filePath)) return true
      }
    } else if (p.test(filePath)) {
      return true
    }
  }
  return false
}

function createFilter(ignore) {
  if (!ignore || !ignore.length) return function () { return true }
  return function (filePath) { return !matchesAny(filePath, ignore) }
}

function dirExists(dir) {
  try { return fs.statSync(dir).isDirectory() }
  catch (e) { return false }
}

var subs = {}
var subNextId = 0

function subscribe(dir, fn, opts) {
  opts = opts || {}
  dir = path.resolve(dir)
  var allowEvent = createFilter(opts.ignore)
  var id = subNextId++
  var watched = {}
  var knownFiles = {}
  var closed = false

  function addWatch(watchDir) {
    if (watched[watchDir] || closed) return
    try {
      var watcher = fs.watch(watchDir, function (eventType, filename) {
        if (!filename || closed) return
        var fullPath = path.join(watchDir, filename.toString())
        if (!allowEvent(fullPath)) return
        var events = []
        if (eventType === "rename") {
          var exists = dirExists(fullPath) || fs.existsSync(fullPath)
          if (knownFiles[fullPath] !== undefined) {
            delete knownFiles[fullPath]
            if (!exists) events.push({ path: fullPath, type: "delete" })
          }
          if (exists) {
            knownFiles[fullPath] = true
            events.push({ path: fullPath, type: "create" })
            if (dirExists(fullPath)) {
              try {
                var subEntries = fs.readdirSync(fullPath, { withFileTypes: true })
                for (var i = 0; i < subEntries.length; i++) {
                  var subPath = path.join(fullPath, subEntries[i].name)
                  knownFiles[subPath] = true
                  if (subEntries[i].isDirectory()) addWatch(subPath)
                }
              } catch (e) {}
            }
          }
        } else if (eventType === "change") {
          knownFiles[fullPath] = true
          events.push({ path: fullPath, type: "update" })
        }
        if (events.length) fn(null, events)
      })
      watched[watchDir] = watcher
    } catch (e) {}
  }

  function discoverDirs(dirPath) {
    addWatch(dirPath)
    try {
      var entries = fs.readdirSync(dirPath, { withFileTypes: true })
      for (var i = 0; i < entries.length; i++) {
        var fullPath = path.join(dirPath, entries[i].name)
        if (entries[i].isDirectory()) {
          discoverDirs(fullPath)
        } else {
          knownFiles[fullPath] = true
        }
      }
    } catch (e) {}
  }

  discoverDirs(dir)
  subs[id] = { watched: watched, knownFiles: knownFiles, closed: closed }

  return Promise.resolve({
    unsubscribe: function () {
      return new Promise(function (resolve) {
        closed = true
        for (var wd in watched) {
          if (watched.hasOwnProperty(wd)) {
            try { watched[wd].close() } catch (e) {}
          }
        }
        delete subs[id]
        resolve()
      })
    }
  })
}

function unsubscribe(dir, fn, opts) {
  for (var id in subs) {
    if (subs.hasOwnProperty(id)) {
      var sub = subs[id]
      sub.closed = true
      for (var watchDir in sub.watched) {
        if (sub.watched.hasOwnProperty(watchDir)) {
          try { sub.watched[watchDir].close() } catch (e) {}
        }
      }
      delete subs[id]
    }
  }
  return Promise.resolve()
}

function writeSnapshot(dir, snapshot, opts) {
  return Promise.resolve(snapshot)
}

function getEventsSince(dir, snapshot, opts) {
  return Promise.resolve([])
}

module.exports = { subscribe: subscribe, unsubscribe: unsubscribe, writeSnapshot: writeSnapshot, getEventsSince: getEventsSince }
