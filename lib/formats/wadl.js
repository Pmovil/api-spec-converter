'use strict';

var _ = require('lodash');
var assert = require('assert');
var Inherits = require('util').inherits;
var Path = require('path');
var URI = require('urijs');
var Promise = require('bluebird');
var Xml2Js = require('xml2js');

var BaseFormat = require('../base_format.js');
var Util = require('../util.js');

var WADL = module.exports = function() {
  WADL.super_.apply(this, arguments);
  this.format = 'wadl';

  this.converters.swagger_2 =
    Promise.method(wadl => convertToSwagger(wadl.spec));
}

Inherits(WADL, BaseFormat);

WADL.prototype.formatName = 'wadl';
WADL.prototype.supportedVersions = ['1.0'];
WADL.prototype.getFormatVersion = function () {
  return '1.0';
}

WADL.prototype.parsers = {
  'XML': data => Promise.promisify(Xml2Js.parseString)(data, {
    //HACK: we just strip namespace. Yes I know, it's ugly.
    //But handling XML namespaces is even uglier.
    tagNameProcessors: [Xml2Js.processors.stripPrefix],
    attrNameProcessors: [Xml2Js.processors.stripPrefix]
  })
};

WADL.prototype.checkFormat = function (spec) {
  return true;
}

function convertToSwagger(wadl) {
  var convertStyle = function(style) {
    switch (style) {
      case 'query':
      case 'header':
        return style;
      case 'template':
        return 'path';
      case 'plain':
        return 'body';
      default:
        assert(false);
    }
  }
  var convertType = function(wadlType) {
    if (_.isUndefined(wadlType))
      return {};

    //HACK: we just strip namespace. Yes I know, it's ugly.
    //But handling XML namespaces is even uglier.
    var match = wadlType.match(/^(?:[^:]+:)?(.+)$/);
    assert(match, wadlType);
    var type = match[1];
    switch (type.toLowerCase()) {
      case 'boolean':
      case 'string':
      case 'integer':
        return {type: type};
      case 'double':
      case 'decimal':
        return {type: 'number'};
      case 'int':
        return {type: 'integer', format: 'int32'};
      case 'long':
        return {type: 'integer', format: 'int64'};
      case 'positiveInteger':
        return {type: 'integer', minimum: 1};
      case 'anyURI':
      case 'date':
      case 'time':
      case 'date-time':
        //TODO: add 'format' where possible
        return {type: 'string'};
      default:
        //HACK: convert unknown types into 'string' these works for everything,
        //except body and responces but we don't support them yet.
        return {type: 'string'};
        //TODO: add warning
        //assert(false, 'Unsupported type: ' + wadlType);
    }
  }

  var convertDoc = function (doc) {
    if (_.isUndefined(doc))
      return {};

    assert(_.isArray(doc));
    var result = {};
    _.each(doc, function (docElement) {
      if (_.isPlainObject(docElement)) {
        //Handle Apigee extension
        var externalUrl = docElement.$['url'];
        if (externalUrl)
          result.externalDocs = {url: externalUrl};
        docElement = docElement._;
        if (!_.isString(docElement))
          return;
      }

      assert(_.isString(docElement));
      docElement = docElement.trim();
      if (result.description)
        result.description += '\n' + docElement;
      else
        result.description = docElement;
    });
    return result;
  }

  var convertDefault = function (wadlDefault, type) {
    if (type === 'string')
      return wadlDefault;
    return JSON.parse(wadlDefault);
  }

  var convertParameter = function(wadlParam) {
    var loc = convertStyle(wadlParam.$.style);
    var ret = {
      name: wadlParam.$.name,
      required: loc === 'path' ? true : JSON.parse(wadlParam.$.required || 'false'),
      in: loc,
      type: 'string', //default type
    };
    _.assign(ret, convertType(wadlParam.$.type));

    var wadlDefault = wadlParam.$.default;
    if (!_.isUndefined(wadlDefault))
      ret.default = convertDefault(wadlDefault, ret.type);

    var doc = convertDoc(wadlParam.doc);
    //FIXME:
    delete doc.externalDocs;
    _.extend(ret,doc);

    if (wadlParam.option) {
      ret.enum = wadlParam.option.map(function(opt) {
        return opt.$.value;
      })
    }
    return ret;
  }

  var convertParameter2JsonSchema = function (wadlParam){
      
      var path = wadlParam.$.path;
      var isArray = (path.slice(-3) === '[n]');
      
      var parts = path.split('[n].');
      var numOpenBrackets = (parts.length-1)*3 + 1;
      var schemaSkeleton = '{"' + parts.join('":{"type":"array","items":{"type":"object","properties":{"');

      parts = schemaSkeleton.split('.');
      numOpenBrackets += (parts.length-1)*2;
      schemaSkeleton = parts.join('":{"type":"object","properties":{"');

      if(isArray){
          schemaSkeleton = schemaSkeleton.replace('[n]','":{"type":"array","items":');
          numOpenBrackets++;
      } else {
          schemaSkeleton += '":';
      }

      var param = convertType(wadlParam.$.type);
      //param.required = JSON.parse(wadlParam.$.required || 'false');

      schemaSkeleton += JSON.stringify(param) +'}'.repeat(numOpenBrackets);

      return JSON.parse(schemaSkeleton);
  };


  function unwrapArray(array) {
    if (_.isUndefined(array))
      return;

    assert(_.isArray(array));
    assert(_.size(array) === 1);
    return array[0];
  }

    function convertRepresentation(wadlRepresentation) {
        
        var representations = {};
        
        wadlRepresentation.forEach(function (representation) {
            //FIXME: implement all possible response definitions
            if (representation.$ && representation.$.mediaType) {
                if (representation.$.mediaType == 'application/json') {
                    var schema = {};
                    if(representation.param){
                        representation.param.forEach(function (param) {
                            if (param.$.style == 'plain') {
                                _.merge(schema, convertParameter2JsonSchema(param));
                            }
                        });
                    }
                    
                    if(!_.isEmpty(schema)){
                        representations['application/json'] = {
                            'type': 'object',
                            'properties': schema
                        };
                    }
                }
            }
        });
        return representations;
    }

  function convertResponses(wadlResponses){
      //mantaining default response for back-compatibility
      var responses = {
        200: {
          description: 'Successful Response'
        }
      }

      wadlResponses.forEach(function(wadlResponse){
          var statuses = (wadlResponse.$ && wadlResponse.$.status)?wadlResponse.$.status.split(' '):['200'];


          if(wadlResponse.representation){
            var representations = convertRepresentation(wadlResponse.representation);
            for(var mediaType in representations){
                statuses.forEach(function(status){
                    //Need to check if schema is a value distinct from object
                    if(mediaType == 'application/json'){
                        //FIXME: description = docs?
                        responses[status] = {
                            schema: representations[mediaType],
                            description: status
                        }
                    }
                }); 
            }
          }
      });
      return responses;
  }

  function convertMethod(wadlMethod) {

    var method = {
      operationId: wadlMethod.$.id,
      responses: {
        //FIXME: take responses from WADL file
        200: {
          description: 'Successful Response'
        }
      }
    };

    var wadlRequest = unwrapArray(wadlMethod.request);
    if (wadlRequest){
      method.parameters = _.map(wadlRequest.param, convertParameter);
        if(wadlRequest.representation){
            var representations = convertRepresentation(wadlRequest.representation);
            if (!_.isEmpty(representations['application/json'])) {
                method.parameters.push({
                    'name': 'body',
                    'in': 'body',
                    'schema': representations['application/json']
                });
            }
        }
    }

    _.extend(method, convertDoc(wadlMethod.doc));

    if(wadlMethod.response)
        method.responses = convertResponses(wadlMethod.response);

    return method;
  }

  // Jersey use very strange extension to WADL. See:
  // https://docs.oracle.com/cd/E19776-01/820-4867/6nga7f5nc/index.html
  // They add {<name>: <regex>} template parameters which should be converted
  // to {<name>}. Tricky part is find end of regexp.
  function convertPath(path) {
    function indexOf(ch, startPosition) {
      var pos = path.indexOf(ch, startPosition);
      if (pos === -1)
        return pos;

      var slashNumber = 0;
      while (path.charAt(pos - 1 - slashNumber) === '\\')
        ++slashNumber;

      if (slashNumber % 2 === 0)
        return pos;

      //Skip escaped symbols
      return indexOf(ch, pos + 1);
    }

    var match;

    //RegEx should be inside loop to reset iteration
    while (match = /{([^}:]+):/g.exec(path)) {
      var deleteBegin = match.index + match[0].length - 1;
      var deleteEnd = deleteBegin;

      var unmatched = 1;
      while (unmatched !== 0) {

        var open = indexOf('{', deleteEnd + 1);
        var close = indexOf('}', deleteEnd + 1);

        if (close === -1)
          throw Error('Unmatched curly brackets in path: ' + path);

        if (open !==  -1 && open < close) {
          ++unmatched;
          deleteEnd = open;
        }
        else {
          --unmatched;
          deleteEnd = close;
        }
      }

      //For future use: regex itself is
      //path.substring(deleteBegin + 1, deleteEnd)

      path = path.slice(0, deleteBegin) + path.slice(deleteEnd);
    }

    return path;
  }

  function convertResource(wadlResource) {
    var resourcePath = Util.joinPath('/', convertPath(wadlResource.$.path));
    var paths = {};

    //Not supported
    assert(!_.has(wadlResource, 'resource_type'));
    assert(!_.has(wadlResource, 'resource_type'));

    var resource = {};
    var commonParameters = _.map(wadlResource.param, convertParameter);

    _.each(wadlResource.method, function(wadlMethod) {
      var httpMethod = wadlMethod.$.name.toLowerCase();
      resource[httpMethod] = convertMethod(wadlMethod);
    });

    if (!_.isEmpty(resource)) {
      resource.parameters = commonParameters;
      paths[resourcePath] = resource;
    }

    _.each(wadlResource.resource, function (wadlSubResource) {
      var subPaths = convertResource(wadlSubResource);
      subPaths = _.mapKeys(subPaths, function (subPath, path) {
        subPath.parameters = commonParameters.concat(subPath.parameters);
        return Util.joinPath(resourcePath, convertPath(path));
      });
      mergePaths(paths, subPaths);
    });
    
    
    

      _.each(paths, function (pathObj, path){
          var plainPath = path.split(/[\{\}]/).join('');
          var capitalized = '';
          _.each(plainPath.split('/'), function(part){
              if(!_.isEmpty(part)){
                capitalized += part.charAt(0).toUpperCase() + part.slice(1);
              }
          });
          
          _.each(pathObj, function (methodObj, method){
              _.each(methodObj.parameters, function(paramObj, param){
                  if(paramObj.in == 'body' && paramObj.schema && !paramObj.schema.title){
                      paths[path][method]['parameters'][param].schema.title = capitalized + method.charAt(0).toUpperCase() + method.slice(1) + 'Request';
                  }
              });
              _.each(methodObj.responses, function(resp, status){
                if(resp.schema && !resp.schema.title){
                    paths[path][method].responses[status].schema.title = capitalized + method.charAt(0).toUpperCase() + method.slice(1) + status +'Response';
                }
              });
              
          });          
      });    
    return paths;
  }

  function mergePaths(paths, pathsToAdd) {
    _.each(pathsToAdd, function (resource, path) {
      var existingResource = paths[path];
      if (!_.isUndefined(existingResource)) {
        assert(_.isEqual(existingResource.parameters, resource.parameters));
        _.extend(existingResource, resource);
      }
      else
        paths[path] = resource;
    });
  }

  var root = unwrapArray(wadl.application.resources);
  var baseUrl = URI(root.$.base);
  
  var title = 'Default Title';
  
  if(wadl.application.doc && wadl.application.doc[0].$ && wadl.application.doc[0].$.title){
      title = wadl.application.doc[0].$.title;
  } 
  
  var swagger = {
    swagger: '2.0',
    host:  baseUrl.host() || undefined,
    basePath: baseUrl.pathname() || undefined,
    schemes: baseUrl.protocol() ? [baseUrl.protocol()] : undefined,
    info: {
        title: title,
        version: '1.0.0'
    },
    paths: {}
  };

  _.each(root.resource, function(wadlResource) {
    mergePaths(swagger.paths, convertResource(wadlResource));
  });

  return swagger;
}

