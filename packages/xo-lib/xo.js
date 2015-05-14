'use strict'

// ===================================================================

var Bluebird = require('bluebird')
var Collection = require('xo-collection').default
var forEach = require('lodash.foreach')
var Index = require('xo-collection/index')
var isString = require('lodash.isstring')
var startsWith = require('lodash.startswith')

var Api = require('./api')
var BackOff = require('./back-off')
var ConnectionError = require('./connection-error')
var SessionError = require('./session-error')

// ===================================================================

function makeStandaloneDeferred () {
  var resolve, reject

  var promise = new Bluebird(function (resolve_, reject_) {
    resolve = resolve_
    reject = reject_
  })
  promise.resolve = resolve
  promise.reject = reject

  return promise
}

function noop () {}

function setMultiple (collection, items) {
  forEach(items, function (item) {
    collection.set(item)
  })
}

function unsetMultiple (collection, items) {
  forEach(items, function (item) {
    collection.unset(item)
  })
}

// ===================================================================

function Xo (opts) {
  if (!opts) {
    opts = {}
  } else if (isString(opts)) {
    opts = {
      url: opts
    }
  }

  // -----------------------------------------------------------------

  var api = new Api(opts.url)

  api.on('connected', function () {
    this._backOff.reset()
    this.status = 'connected'

    this._tryToOpenSession()
  }.bind(this))

  api.on('disconnected', function () {
    this._closeSession()
    this._connect()
  }.bind(this))

  api.on('notification', function (notification) {
    if (notification.method !== 'all') {
      return
    }

    var method = notification.params.type === 'exit' ?
      unsetMultiple :
      setMultiple

    method(this.objects, notification.params.items)
  }.bind(this))

  // -----------------------------------------------------------------

  var objects = this.objects = new Collection()
  objects.getKey = function (item) {
    return item.UUID || item.ref || 'undefined'
  }
  objects.createIndex('ref', new Index('ref'))
  objects.createIndex('type', new Index('type'))
  objects.createIndex('UUID', new Index('UUID'))

  this.status = 'disconnected'
  this.user = null

  this._api = api
  this._backOff = new BackOff()
  this._credentials = opts.creadentials
  this._session = makeStandaloneDeferred()
  this._signIn = null

  // -----------------------------------------------------------------

  this._connect()
}

Xo.prototype.call = function (method, params) {
  // Prevent session.*() from being because it may interfere
  // with this class session management.
  if (startsWith(method, 'session.')) {
    return Bluebird.reject(
      new Error('session.*() methods are disabled from this interface')
    )
  }

  return this._session.bind(this).then(function () {
    return this._api.call(method, params)
  }).catch(ConnectionError, SessionError, function () {
    // Automatically requeue this call.
    return this.call(method, params)
  })
}

Xo.prototype.signIn = function (credentials) {
  this.signOut()

  this._credentials = credentials
  this._signIn = makeStandaloneDeferred()

  this._tryToOpenSession()

  return this._signIn
}

Xo.prototype.signOut = function () {
  this._closeSession()
  this._credentials = null

  var signIn = this._signIn
  if (signIn && signIn.isPending()) {
    signIn.reject(new SessionError('sign in aborted'))
  }

  return this.status === 'connected' ?

    // Attempt to sign out and ignore any return values and errors.
    this._api.call('session.signOut').then(noop, noop) :

    // Always return a promise.
    Bluebird.resolve()
}

Xo.prototype._connect = function _connect () {
  this.status = 'connecting'

  return this._api.connect().bind(this).catch(function (error) {
    console.warn('could not connect:', error)

    return this._backOff.wait().bind(this).then(_connect)
  })
}

Xo.prototype._closeSession = function () {
  if (!this._session.isPending()) {
    this._session = makeStandaloneDeferred()
  }

  this.user = null
}

Xo.prototype._tryToOpenSession = function () {
  var credentials = this._credentials
  if (!credentials || this.status !== 'connected') {
    return
  }

  this._api.call(
    credentials.token ?
      'session.signInWithToken' :
      'session.signInWithPassword',
    credentials
  ).bind(this).then(
    function (user) {
      this.user = user

      this._api.call('xo.getAllObjects').bind(this).then(function (objects) {
        this.objects.clear()
        setMultiple(this.objects, objects)
      })

      // Validate the sign in.
      var signIn = this._signIn
      if (signIn) {
        signIn.resolve()
      }

      // Open the session.
      this._session.resolve()
    },

    function (error) {
      // Reject the sign in.
      var signIn = this._signIn
      if (signIn) {
        signIn.reject(error)
      }
    }
  )
}

// ===================================================================

module.exports = Xo
