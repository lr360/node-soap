/*
 * Copyright (c) 2011 Vinay Pulim <vinay@milewise.com>
 * MIT Licensed
 */

"use strict";

function getDateString(d) {
  function pad(n) {
    return n < 10 ? '0' + n : n;
  }

  return d.getUTCFullYear() + '-'
    + pad(d.getUTCMonth() + 1) + '-'
    + pad(d.getUTCDate()) + 'T'
    + pad(d.getUTCHours()) + ':'
    + pad(d.getUTCMinutes()) + ':'
    + pad(d.getUTCSeconds()) + 'Z';
}

var url = require('url'),
  compress = null,
  events = require('events'),
  util = require('util'),
  findPrefix = require('./utils').findPrefix;

try {
  compress = require("compress");
} catch (error) {
}

var HapiServer = function (server, route, services, wsdl, options) {
  var self = this;

  events.EventEmitter.call(this);

  options = options || {};
  this.path = route.path;
  this.services = services;
  this.wsdl = wsdl;
  this.suppressStack = options && options.suppressStack;

  wsdl.onReady(function (err) {
    server.log(['soap'], 'WSDL ready');
    server.log(['soap'], 'Mount path "' + route.path + '" for services');

    server.route([
      {
        method: 'GET',
        path: route.path + '/wsdl',
        handler: function (req, h) {
          return h.response(self.wsdl.toXML()).type('text/xml');
        }
      },
      {
        method: 'POST',
        path: route.path,
        handler: function (req, h) {
          try {
            if (typeof self.authorizeConnection === 'function') {
              if (!self.authorizeConnection(req)) {
                return h.response().code(401);
              }
            }
            console.log("WAS A POST")
            return self._processRequestXml(req, h, req.payload);
          }
          catch (err) {
            console.log('*'.repeat(200));
            console.log(err);

            var error = err.stack ? (self.suppressStack === true ? err.message : err.stack) : err;
            self.logMsg("error-handler", error);

            return self._sendError(
              {
                Code: {
                  Value: 'soap:Server',
                  Subcode: {
                    value: 'InternalError'
                  }
                },
                Reason: {
                  Text: err.message
                }
              },
              function (result, statusCode) {
                var response = h.response(result);
                response.code(statusCode || 500);
                response.type('text/xml; charset=utf-8');
                return response
              },
              new Date().toISOString()
            );
          }
        }
      }
    ]);
  });

  this._initializeOptions(options);
};
util.inherits(HapiServer, events.EventEmitter);

HapiServer.prototype.logMsg = function logMsg(tag, msg) {
  if (typeof this.log === 'function') {
    this.log(tag, msg);
  }
};

HapiServer.prototype._initializeOptions = function (options) {
  this.wsdl.options.attributesKey = options.attributesKey || 'attributes';
};

HapiServer.prototype._processRequestXml = function (req, h, xml) {
  var self = this;
  try {
    self.logMsg("received", xml);

    return self._process(xml, req, function (result, statusCode, responseHeaders) {
      self.logMsg("replying", result);

      var response = h.response(result);
      if (responseHeaders) {
        _.forOwn(responseHeaders, function (value, key) {
          response.header('x-lr360-' + _.kebabCase(key), value);
        });
      }
      response.code(statusCode || 200);
      response.type('text/xml; charset=utf-8');
      return response
    });
  } catch (err) {
    console.log("ERRRRrRRRRRrRRRRRr", err)
    if (err.Fault !== undefined) {
      return self._sendError(err.Fault, function (result, statusCode) {
        self.logMsg("error", err);
        var response = h.response(result);
        response.code(statusCode || 500);
        response.type('text/xml; charset=utf-8');
        return response
      }, new Date().toISOString());
    } else {
      var error = err.stack ? (self.suppressStack === true ? err.message : err.stack) : err;
      self.logMsg("error-_processRequestXml", error);

      return self._sendError(
        {
          Code: {
            Value: 'soap:Server',
            Subcode: {
              value: 'InternalError'
            }
          },
          Reason: {
            Text: err.message
          }
        },
        function (result, statusCode) {
          var response = h.response(result);
          response.code(statusCode || 500);
          response.type('text/xml; charset=utf-8');
          return response
        },
        new Date().toISOString()
      );
    }
  }
};

HapiServer.prototype._process = function (input, req, callback) {
  var self = this,
    pathname = url.parse(req.url).pathname.replace(/\/$/, ''),
    obj = this.wsdl.xmlToObject(input),
    body = obj.Body,
    headers = obj.Header,
    bindings = this.wsdl.definitions.bindings,
    binding,
    method,
    methodName,
    serviceName,
    portName,
    includeTimestamp = obj.Header && obj.Header.Security && obj.Header.Security.Timestamp;

  if (typeof self.authenticate === 'function') {
    if (!obj.Header || !obj.Header.Security) {
      throw new Error('No security header');
    }
    if (!self.authenticate(obj.Header.Security)) {
      throw new Error('Invalid username or password');
    }
  }

  self.logMsg("info", "Attempting to bind to " + pathname);

  //Avoid Cannot convert undefined or null to object due to Object.keys(body)
  //and throw more meaningful error
  if (!body) {
    throw new Error('Failed to parse the SOAP Message body');
  }

  // use port.location and current url to find the right binding
  binding = (function (self) {
    var services = self.wsdl.definitions.services;
    var firstPort;
    var name;
    for (name in services) {
      serviceName = name;
      var service = services[serviceName];
      var ports = service.ports;
      for (name in ports) {
        portName = name;
        var port = ports[portName];
        var portPathname = url.parse(port.location).pathname.replace(/\/$/, '');

        self.logMsg("info", "Trying " + portName + " from path " + portPathname);

        if (portPathname === pathname) {
          return port.binding;
        }

        // The port path is almost always wrong for generated WSDLs
        if (!firstPort) {
          firstPort = port;
        }
      }
    }
    return !firstPort ? void 0 : firstPort.binding;
  })(this);

  if (!binding) {
    throw new Error('Failed to bind to WSDL');
  }

  try {
    console.log("BINDING STYLE", binding.style)
    if (binding.style === 'rpc') {
      methodName = Object.keys(body)[0];

      self.emit('request', obj, methodName);
      if (headers) {
        self.emit('headers', headers, methodName);
      }

      return self._executeMethod({
        serviceName: serviceName,
        portName: portName,
        methodName: methodName,
        outputName: methodName + 'Response',
        args: body[methodName],
        headers: headers,
        style: 'rpc'
      }, req, callback);
    } else {
      var messageElemName = (Object.keys(body)[0] === 'attributes' ? Object.keys(body)[1] : Object.keys(body)[0]);
      var pair = binding.topElements[messageElemName];

      self.emit('request', obj, pair.methodName);
      if (headers) {
        self.emit('headers', headers, pair.methodName);
      }

      return self._executeMethod({
        serviceName: serviceName,
        portName: portName,
        methodName: pair.methodName,
        outputName: pair.outputName,
        args: body[messageElemName],
        headers: headers,
        style: 'document'
      }, req, callback, includeTimestamp);
    }
  }
  catch (error) {
    console.log("POTATOES", error)
    if (error.Fault !== undefined) {
      return self._sendError(error.Fault, callback, includeTimestamp);
    }
    throw error;
  }
};

HapiServer.prototype._executeMethod = function (options, req, callback, includeTimestamp) {

  options = options || {};
  var self = this,
    method,
    body,
    serviceName = options.serviceName,
    portName = options.portName,
    methodName = options.methodName,
    outputName = options.outputName,
    args = options.args,
    style = options.style,
    handled = false;

  try {
    method = this.services[serviceName][portName][methodName];
  } catch (error) {
    self.logMsg('error', error);

    // FIXME (SG): Missing implementation
    return callback(this._envelope('', includeTimestamp));
  }

  if (!method) {
    return self._sendError({
        Code: {
          Value: 'soap:Server',
          Subcode: {
            value: 'document:NotImplemented'
          }
        },
        Reason: {
          Text: '"' + serviceName + ':' + portName + ':' + methodName + '" is not implemented'
        },
        statusCode: 500,
      },
      callback, includeTimestamp
    );
  }

  function handleResult(error, result) {
    if (handled) {
      return;
    }

    handled = true;

    if (error && error.Fault !== undefined) {
      return self._sendError(error.Fault, callback, includeTimestamp);
    }
    else if (result === undefined) {
      // Backward compatibility to support one argument callback style
      result = error;
    }

    if (style === 'rpc') {
      body = self.wsdl.objectToRpcXML(outputName, result, '', self.wsdl.definitions.$targetNamespace);
    } else {
      var element = self.wsdl.definitions.services[serviceName].ports[portName].binding.methods[methodName].output;
      body = self.wsdl.objectToDocumentXML(outputName, result, element.targetNSAlias, element.targetNamespace);
    }
    return callback(self._envelope(body, includeTimestamp));
  }

  if (!self.wsdl.definitions.services[serviceName].ports[portName].binding.methods[methodName].output) {
    // no output defined = one-way operation so return empty response
    handled = true;
    return callback('');
  }

  return method(args, handleResult, options.headers, req);
};

HapiServer.prototype.addSoapHeader = function (soapHeader, name, namespace, xmlns) {
  if (!this.soapHeaders) {
    this.soapHeaders = [];
  }
  if (typeof soapHeader === 'object') {
    soapHeader = this.wsdl.objectToXML(soapHeader, name, namespace, xmlns, true);
  }
  return this.soapHeaders.push(soapHeader) - 1;
};

HapiServer.prototype.changeSoapHeader = function (index, soapHeader, name, namespace, xmlns) {
  if (!this.soapHeaders) {
    this.soapHeaders = [];
  }
  if (typeof soapHeader === 'object') {
    soapHeader = this.wsdl.objectToXML(soapHeader, name, namespace, xmlns, true);
  }
  this.soapHeaders[index] = soapHeader;
};

HapiServer.prototype.getSoapHeaders = function () {
  return this.soapHeaders;
};

HapiServer.prototype.clearSoapHeaders = function () {
  this.soapHeaders = null;
};

HapiServer.prototype._envelope = function (body, includeTimestamp) {
  var defs = this.wsdl.definitions,
    ns = defs.$targetNamespace,
    encoding = '',
    alias = findPrefix(defs.xmlns, ns);
  var xml = "<?xml version=\"1.0\" encoding=\"utf-8\"?>" +
    "<soap:Envelope xmlns:soap=\"http://schemas.xmlsoap.org/soap/envelope/\" " +
    encoding +
    this.wsdl.xmlnsInEnvelope + '>';
  var headers = '';

  if (includeTimestamp) {
    var now = new Date();
    var created = getDateString(now);
    var expires = getDateString(new Date(now.getTime() + (1000 * 600)));

    headers += "<o:Security soap:mustUnderstand=\"1\" " +
      "xmlns:o=\"http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd\" " +
      "xmlns:u=\"http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd\">" +
      "    <u:Timestamp u:Id=\"_0\">" +
      "      <u:Created>" + created + "</u:Created>" +
      "      <u:Expires>" + expires + "</u:Expires>" +
      "    </u:Timestamp>" +
      "  </o:Security>\n";
  }

  if (this.soapHeaders) {
    headers += this.soapHeaders.join("\n");
  }

  if (headers !== '') {
    xml += "<soap:Header>" + headers + "</soap:Header>";
  }

  xml += "<soap:Body>" +
    body +
    "</soap:Body>" +
    "</soap:Envelope>";
  return xml;
};

HapiServer.prototype._sendError = function (soapFault, callback, includeTimestamp) {
  var self = this,
    fault;

  var statusCode;
  if (soapFault.statusCode) {
    statusCode = soapFault.statusCode;
    soapFault.statusCode = undefined;
  }

  if (soapFault.faultcode) {
    // Soap 1.1 error style
    // Root element will be prependend with the soap NS
    // It must match the NS defined in the Envelope (set by the _envelope method)
    fault = self.wsdl.objectToDocumentXML("soap:Fault", soapFault, undefined);
  }
  else {
    // Soap 1.2 error style.
    // 3rd param is the NS prepended to all elements
    // It must match the NS defined in the Envelope (set by the _envelope method)
    fault = self.wsdl.objectToDocumentXML("Fault", soapFault, "soap");
  }

  return callback(self._envelope(fault, includeTimestamp), statusCode);
};

exports.HapiServer = HapiServer;
