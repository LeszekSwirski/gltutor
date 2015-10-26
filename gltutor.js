"use strict";

var gl;
var server;

function Rect(top,left,width,height) {
    this.top = top;
    this.left = left;
    this.width = width;
    this.height = height;
}
Rect.prototype.contains = function(x,y) {
    return x >= this.left && y >= this.top && x < this.left+this.width && y < this.top+this.height;
};
Rect.prototype.distance = function(x,y) {
    x = x - this.left;
    y = y - this.top;
    var rx = Math.max(Math.min(x, this.width), 0);
    var ry = Math.max(Math.min(y, this.height), 0);
    return Math.sqrt((x-rx)*(x-rx) + (y-ry)*(y-ry));
};
Rect.prototype.minkowskiDifference = function(r) {
    return new Rect(
        r.top - this.top - this.height,
        this.left - r.left - r.width,
        this.width + r.width,
        this.height + r.height);
};
Rect.prototype.rectDistance = function(r) {
    return this.minkowskiDifference(r).distance(0,0);
};

jQuery.fn.extend({
    centre: function() {
        return this.css({
            "position":"fixed",
            "top": (window.innerHeight - this.outerHeight()) / 2,
            "left": (window.innerWidth - this.outerWidth()) / 2
        });
    },
    bounds: function() {
        var bounds = {
            left: Number.POSITIVE_INFINITY,
            top: Number.POSITIVE_INFINITY,
            right: Number.NEGATIVE_INFINITY,
            bottom: Number.NEGATIVE_INFINITY,
            width: Number.NaN,
            height: Number.NaN
        };

        this.each(function (i,el) {
            var elQ = $(el);
            var off = elQ.offset();
            off.right = off.left + $(elQ).outerWidth();
            off.bottom = off.top + $(elQ).outerHeight();

            if (off.left < bounds.left)
            bounds.left = off.left;

            if (off.top < bounds.top)
            bounds.top = off.top;

            if (off.right > bounds.right)
            bounds.right = off.right;

            if (off.bottom > bounds.bottom)
            bounds.bottom = off.bottom;
        });

        bounds.width = bounds.right - bounds.left;
        bounds.height = bounds.bottom - bounds.top;
        return new Rect(bounds.top, bounds.left, bounds.width, bounds.height);
    },
});

(function() {

var pixel_size = 15;
var canvas, overlay, editor, vs_editor, fs_editor, errorLineMsg;
//var gl;
var errorLines = [];
var curExecuting;
var accurateRuntimeChecks = true;
var debugCodeInjection = false;

var sandbox = new Sandbox(true);


var queue = {
    _queue: [],
    _version: 0,
    add: function(fn, time_after_prev) {
        time_after_prev = time_after_prev === undefined ? 0 : time_after_prev;
        var now_time = $.now(),
            prev_time,
            exec_time;
        if (queue._queue.length > 0)
            prev_time = queue._queue[queue._queue.length - 1][1];
        else
            prev_time = now_time;
        exec_time = prev_time + time_after_prev;

        queue._queue.push([fn, exec_time]);

        var version_when_added = queue._version;
        setTimeout(function() {
            if (queue._version != version_when_added)
                return;

            var next = queue._queue.shift();
            if (!next) {
                return;
            }
            next[0].call(next[1] || window);
        }, exec_time - now_time);//time === undefined ? 100 : time);
    },
    clear: function() {
        queue._queue = [];
        queue._version++;
    }
};

function initcanvas() {
    overlay.clearCanvas();

    var body = $("body");
    var canvaspanel = $("#canvaspanel");
    var codepanel = $("#codepanel");
    var width = body.innerWidth() - codepanel.innerWidth();
    var height = canvaspanel.innerHeight()
    canvaspanel.css({
        "width": width,
        "left": codepanel.innerWidth()
    })
    canvas.attr("width", width).attr("height", height);
    overlay.attr("width", width).attr("height", height);

    //gl.clearColor(0.0, 0.0, 0.0, 1.0);                      // Set clear color to black, fully opaque
    gl.enable(gl.DEPTH_TEST);                               // Enable depth testing
    gl.depthFunc(gl.LEQUAL);                                // Near things obscure far things
    //gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);      // Clear the color as well as the depth buffer.

    gl.viewport(0, 0, width, height);
}
function toColour(colour, defaultColour) {
    if (colour === undefined)
        return defaultColour;
    else if (_.isArray(colour)) {
        if (colour.length === 3)
            return "rgb(" + colour.join(",") + ")";
        else if (colour.length === 4)
            return "rgba(" + colour.join(",") + ")";
        else
            throw new Error("Invalid colour " + colour)
    }
    else
        return colour;
}
function drawPixel(x,y,colour) {
    //print("drawing pixel at " + x + "," + y)

    if (x != Math.floor(x)) {
        var e = new Error("Pixel locations must be integers");
        e.arg = 0;
        throw e;
    }
    if (y != Math.floor(y)) {
        var e = new Error("Pixel locations must be integers");
        e.arg = 1;
        throw e;
    }

    colour = toColour(colour, "#000");

    queue.add(function() {
        canvas.drawRect({
            fillStyle: colour,
            x: x*pixel_size, y: y*pixel_size,
            width: pixel_size,
            height: pixel_size,
            fromCenter: false
        });
    }, 0);
}
function do_print(val) {
    $("#console").html($("#console").html()+val+"\n");
}
function print() {
    //do_print(val);
    var str = _.map(arguments, function(arg) { return arg.toString() }).join(", ");
    queue.add(function() { do_print(str); });
}



function traverse(node, visitors, ancestors) {
    if (_.isArray(node)) {
        node = _.map(node, function(n) {
            return traverse(n,visitors,ancestors);
        });
    }
    else if (_.isObject(node)) {

        if (!ancestors) ancestors = [];

        var visitor;
        var type = node.type;
        if (visitors[type])
            visitor = visitors[type];

        if (_.isFunction(visitor)) {
            var ret = visitor(node, function(n,anc){var ret = traverse(n,visitors,anc||ancestors);return ret||n;}, ancestors);
            if (ret)
                node = ret;
        }
        else {
            _.each(node, function(child,key) {
                if (!_.include(["range"], key)) {
                    ancestors.unshift({node: node, key: key})
                    if (visitor && visitor[key]) {
                        var ret = visitor[key](child, function(n,anc){
                                                          var ret = traverse(n,visitors,anc||ancestors);
                                                          return ret||n;
                                                      }, node, ancestors);
                        if (ret)
                            node[key] = ret;
                    }
                    else {
                        node[key] = traverse(child, visitors, ancestors);
                    }
                    ancestors.shift();
                }
            });
        }
    }
    return node;
}
function astInject(ast, args) {
    var inject_visitor = {
        "Identifier": function(node, traverse) {
            if (node.name.slice(0, 2) == "_$") {
                var argname = node.name.slice(2,node.name.length)
                var value = args[argname];

                var parseValue = function(value) {
                    if ($.isArray(value)) {
                        return {type: "ArrayExpression", elements: value.map(parseValue)};
                    }
                    else if (typeof value === 'object')
                        return value;
                    else
                        return {type: "Literal", value: value};
                }

                return parseValue(value);
            }
        }
    }
    return traverse(ast, inject_visitor);
}
function parseAndInject(code, args) {
    var ast = astInject(esprima.parse(code), args);
    if (ast.body.length == 1)
        return ast.body[0];
    else
        return {type: "BlockStatement", body: ast.body};
}

function injectErrorChecks(code, sandbox_funcs) {

    var ast = esprima.parse(code, {range: true});

    var save_line_visitors = {};
    if (accurateRuntimeChecks) {
        save_line_visitors["MemberExpression"] = function(node, traverse, ancestors){
            node.object = traverse(node.object, [{node:node, key:"object"}].concat(ancestors));
            node.property = traverse(node.property, [{node:node, key:"property"}].concat(ancestors));

            var parent = ancestors[0];
            if (!(parent.node.type === "AssignmentExpression" && parent.key === "left")) {
                var injectStr;
                if (node.computed) {
                    injectStr = "('MemberExpression.computed',function() { var __obj = _$obj, __propname = _$prop; var __prop = __obj[__propname]; if(__prop === undefined) { var e = new Error('Property \"'+__propname+'\" does not exist'); e.range = [_$propfrom,_$propto]; throw e; } if (typeof __prop=='function') return __prop.bind(__obj); else return __prop })()";
                } else {
                    injectStr = "('MemberExpression.uncomputed',function() { var __obj = _$obj; var __prop = __obj._$prop; if(__prop === undefined) { var e = new Error('Property \""+node.property.name+"\" does not exist'); e.range = [_$propfrom,_$propto]; throw e; } if (typeof __prop=='function') return __prop.bind(__obj); else return __prop; })()";
                }

                return parseAndInject(injectStr, {obj: node.object, propfrom: node.property.range[0], propto: node.property.range[1], prop: node.property }).expression;
            }
        }

        save_line_visitors["UpdateExpression"] = function(node, traverse, ancestors) {
            node.argument = traverse(node.argument, [{node:node, key:"argument"}].concat(ancestors));
            if (node.argument.range)
                return parseAndInject("('UpdateExpression',function() { try { return _$value; } catch(e) { if (!e.range) e.range = _$range; throw e; } })()", {range: node.argument.range, value: node }).expression;
        }
        save_line_visitors["Identifier"] = function(node,traverse,ancestors) {
            //console.log("["+_.map(ancestors,function(x){return "{"+x.node.type+","+x.key+"}"}).join(",")+"]")
            var parent = ancestors[0];
            if (parent.node.type === "BinaryExpression"
                || parent.node.type === "ExpressionStatement"
                || parent.node.type === "CallExpression"
                || parent.node.type === "WhileStatement"
                || parent.node.type === "DoWhileStatement"
                || parent.node.type === "ForStatement"
                || parent.node.type === "NewExpression"
                || parent.node.type === "MemberExpression" && (parent.key === "object" || parent.key === "property" && parent.node.computed)
                || parent.node.type === "AssignmentExpression" && parent.key === "right"
                || parent.node.type === "VariableDeclarator" && parent.key === "init"
            ) {
                return _.extend(parseAndInject("('Identifier-"+"["+_.map(ancestors,function(x){return "{"+x.node.type+","+x.key+"}"}).join(",")+"]"+"',function() { try {return _$value} catch(e){ if (!e.range) e.range = _$range; throw e; } })()", {range: node.range, value: node }).expression, {range: node.range});
            }
        }

        save_line_visitors["CallExpression"] = function(node, traverse, ancestors) {
            node.arguments = traverse(node.arguments, [{node:node, key:"arguments"}].concat(ancestors));
            node.callee = traverse(node.callee, [{node:node, key:"callee"}].concat(ancestors));

            var arg_ranges = [];
            for (var i = 0; i < node.arguments.length; i++)
                arg_ranges[i] = node.arguments[i].range;

            return parseAndInject("('CallExpression',function() { try { return _$value; } catch(e) { if (!e.range) e.range = _$range; throw e; } })()", {range: node.range, arg_ranges: arg_ranges, value: node }).expression
        }
    }

    traverse(ast, save_line_visitors);


    var timeout_check = "if(__end_time <= new Date()){ var e = new Error('Timed out after 200ms'); e.range = _$range; throw e; }";

    var repeat_body_visitor = {
        body: function(body, traverse, node) {
            body = traverse(body);
            if (node.range)
                return { type: "BlockStatement", body: [parseAndInject(timeout_check, {range: node.range})].concat(body) }
        }
    };
    var repeat_body_visitors = {
        "WhileStatement": repeat_body_visitor,
        "ForStatement": repeat_body_visitor,
        "DoWhileStatement": repeat_body_visitor,
        "FunctionExpression": repeat_body_visitor,
        "FunctionDeclaration": repeat_body_visitor,
    };
    traverse(ast, repeat_body_visitors);

    var sandbox_func_decls = _.map(sandbox_funcs, function(val,key) {return "var " + key + " = __sandbox_funcs." + key + ";"});
    
    return sandbox_func_decls.join("\n") + "\n" +
           "try { var __start_time = new Date();\n" +
           "var __end_time = new Date();\n" +
           "__end_time.setTime(__start_time.getTime() + 200);\n" +
           "(function(){\n" +
           escodegen.generate(ast) +
           "\n})(); } finally { if(console && console.log) console.log('Executed in ' + (new Date().getTime() - __start_time.getTime()) + 'ms'); }";
}

function Point(x,y) {
    this.x = x;
      this.y = y;
}
Point.prototype.toString = function() {
    return "("+this.x+","+this.y+")";
}
function Edge(from,to) {
    this.from = from;
      this.to = to;
}
Edge.prototype.toString = function() {
    return this.from + "->" + this.to;
};

/* tern defs {{{1 */
var tern_ecma5 = {
  "!name": "ecma5",
  "!define": {"Error.prototype": "Error.prototype"},
  "Infinity": {
    "!type": "number",
    "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Infinity",
    "!doc": "A numeric value representing infinity."
  },
  "undefined": {
    "!type": "?",
    "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/undefined",
    "!doc": "The value undefined."
  },
  "NaN": {
    "!type": "number",
    "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/NaN",
    "!doc": "A value representing Not-A-Number."
  },
  "Object": {
    "!type": "fn()",
    "getPrototypeOf": {
      "!type": "fn(obj: ?) -> ?",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Object/getPrototypeOf",
      "!doc": "Returns the prototype (i.e. the internal prototype) of the specified object."
    },
    "create": {
      "!type": "fn(proto: ?) -> !custom:Object_create",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Object/create",
      "!doc": "Creates a new object with the specified prototype object and properties."
    },
    "defineProperty": {
      "!type": "fn(obj: ?, prop: string, desc: ?)",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Object/defineProperty",
      "!doc": "Defines a new property directly on an object, or modifies an existing property on an object, and returns the object. If you want to see how to use the Object.defineProperty method with a binary-flags-like syntax, see this article."
    },
    "defineProperties": {
      "!type": "fn(obj: ?, props: ?)",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Object/defineProperty",
      "!doc": "Defines a new property directly on an object, or modifies an existing property on an object, and returns the object. If you want to see how to use the Object.defineProperty method with a binary-flags-like syntax, see this article."
    },
    "getOwnPropertyDescriptor": {
      "!type": "fn(obj: ?, prop: string) -> ?",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Object/getOwnPropertyDescriptor",
      "!doc": "Returns a property descriptor for an own property (that is, one directly present on an object, not present by dint of being along an object's prototype chain) of a given object."
    },
    "keys": {
      "!type": "fn(obj: ?) -> [string]",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Object/keys",
      "!doc": "Returns an array of a given object's own enumerable properties, in the same order as that provided by a for-in loop (the difference being that a for-in loop enumerates properties in the prototype chain as well)."
    },
    "getOwnPropertyNames": {
      "!type": "fn(obj: ?) -> [string]",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Object/getOwnPropertyNames",
      "!doc": "Returns an array of all properties (enumerable or not) found directly upon a given object."
    },
    "seal": {
      "!type": "fn(obj: ?)",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Object/seal",
      "!doc": "Seals an object, preventing new properties from being added to it and marking all existing properties as non-configurable. Values of present properties can still be changed as long as they are writable."
    },
    "isSealed": {
      "!type": "fn(obj: ?) -> bool",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Object/isSealed",
      "!doc": "Determine if an object is sealed."
    },
    "freeze": {
      "!type": "fn(obj: ?)",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Object/freeze",
      "!doc": "Freezes an object: that is, prevents new properties from being added to it; prevents existing properties from being removed; and prevents existing properties, or their enumerability, configurability, or writability, from being changed. In essence the object is made effectively immutable. The method returns the object being frozen."
    },
    "isFrozen": {
      "!type": "fn(obj: ?) -> bool",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Object/isFrozen",
      "!doc": "Determine if an object is frozen."
    },
    "prototype": {
      "!stdProto": "Object",
      "toString": {
        "!type": "fn() -> string",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Object/toString",
        "!doc": "Returns a string representing the object."
      },
      "toLocaleString": {
        "!type": "fn() -> string",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Object/toLocaleString",
        "!doc": "Returns a string representing the object. This method is meant to be overriden by derived objects for locale-specific purposes."
      },
      "valueOf": {
        "!type": "fn() -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Object/valueOf",
        "!doc": "Returns the primitive value of the specified object"
      },
      "hasOwnProperty": {
        "!type": "fn(prop: string) -> bool",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Object/hasOwnProperty",
        "!doc": "Returns a boolean indicating whether the object has the specified property."
      },
      "propertyIsEnumerable": {
        "!type": "fn(prop: string) -> bool",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Object/propertyIsEnumerable",
        "!doc": "Returns a Boolean indicating whether the specified property is enumerable."
      }
    },
    "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Object",
    "!doc": "Creates an object wrapper."
  },
  "Function": {
    "!type": "fn(body: string) -> fn()",
    "prototype": {
      "!stdProto": "Function",
      "apply": {
        "!type": "fn(this: ?, args: [?])",
        "!effects": [
          "call and return !this this=!0 !1.<i> !1.<i> !1.<i>"
        ],
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Function/apply",
        "!doc": "Calls a function with a given this value and arguments provided as an array (or an array like object)."
      },
      "call": {
        "!type": "fn(this: ?, args?: ?) -> !this.!ret",
        "!effects": [
          "call and return !this this=!0 !1 !2 !3 !4"
        ],
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Function/call",
        "!doc": "Calls a function with a given this value and arguments provided individually."
      },
      "bind": {
        "!type": "fn(this: ?, args?: ?) -> !custom:Function_bind",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Function/bind",
        "!doc": "Creates a new function that, when called, has its this keyword set to the provided value, with a given sequence of arguments preceding any provided when the new function was called."
      },
      "prototype": "?"
    },
    "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Function",
    "!doc": "Every function in JavaScript is actually a Function object."
  },
  "Array": {
    "!type": "fn(size: number) -> !custom:Array_ctor",
    "isArray": {
      "!type": "fn(value: ?) -> bool",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Array/isArray",
      "!doc": "Returns true if an object is an array, false if it is not."
    },
    "prototype": {
      "!stdProto": "Array",
      "length": {
        "!type": "number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Array/length",
        "!doc": "An unsigned, 32-bit integer that specifies the number of elements in an array."
      },
      "concat": {
        "!type": "fn(other: [?]) -> !this",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Array/concat",
        "!doc": "Returns a new array comprised of this array joined with other array(s) and/or value(s)."
      },
      "join": {
        "!type": "fn(separator?: string) -> string",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Array/join",
        "!doc": "Joins all elements of an array into a string."
      },
      "splice": {
        "!type": "fn(pos: number, amount: number)",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Array/splice",
        "!doc": "Changes the content of an array, adding new elements while removing old elements."
      },
      "pop": {
        "!type": "fn() -> !this.<i>",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Array/pop",
        "!doc": "Removes the last element from an array and returns that element."
      },
      "push": {
        "!type": "fn(newelt: ?) -> number",
        "!effects": [
          "propagate !0 !this.<i>"
        ],
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Array/push",
        "!doc": "Mutates an array by appending the given elements and returning the new length of the array."
      },
      "shift": {
        "!type": "fn() -> !this.<i>",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Array/shift",
        "!doc": "Removes the first element from an array and returns that element. This method changes the length of the array."
      },
      "unshift": {
        "!type": "fn(newelt: ?) -> number",
        "!effects": [
          "propagate !0 !this.<i>"
        ],
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Array/unshift",
        "!doc": "Adds one or more elements to the beginning of an array and returns the new length of the array."
      },
      "slice": {
        "!type": "fn(from: number, to?: number) -> !this",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Array/slice",
        "!doc": "Returns a shallow copy of a portion of an array."
      },
      "reverse": {
        "!type": "fn()",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Array/reverse",
        "!doc": "Reverses an array in place.  The first array element becomes the last and the last becomes the first."
      },
      "sort": {
        "!type": "fn(compare?: fn(a: ?, b: ?) -> number)",
        "!effects": [
          "call !0 !this.<i> !this.<i>"
        ],
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Array/sort",
        "!doc": "Sorts the elements of an array in place and returns the array."
      },
      "indexOf": {
        "!type": "fn(elt: ?, from?: number) -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Array/indexOf",
        "!doc": "Returns the first index at which a given element can be found in the array, or -1 if it is not present."
      },
      "lastIndexOf": {
        "!type": "fn(elt: ?, from?: number) -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Array/lastIndexOf",
        "!doc": "Returns the last index at which a given element can be found in the array, or -1 if it is not present. The array is searched backwards, starting at fromIndex."
      },
      "every": {
        "!type": "fn(test: fn(elt: ?, i: number) -> bool, context?: ?) -> bool",
        "!effects": [
          "call !0 this=!1 !this.<i> number"
        ],
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Array/every",
        "!doc": "Tests whether all elements in the array pass the test implemented by the provided function."
      },
      "some": {
        "!type": "fn(test: fn(elt: ?, i: number) -> bool, context?: ?) -> bool",
        "!effects": [
          "call !0 this=!1 !this.<i> number"
        ],
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Array/some",
        "!doc": "Tests whether some element in the array passes the test implemented by the provided function."
      },
      "filter": {
        "!type": "fn(test: fn(elt: ?, i: number) -> bool, context?: ?) -> !this",
        "!effects": [
          "call !0 this=!1 !this.<i> number"
        ],
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Array/filter",
        "!doc": "Creates a new array with all elements that pass the test implemented by the provided function."
      },
      "forEach": {
        "!type": "fn(f: fn(elt: ?, i: number), context?: ?)",
        "!effects": [
          "call !0 this=!1 !this.<i> number"
        ],
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Array/forEach",
        "!doc": "Executes a provided function once per array element."
      },
      "map": {
        "!type": "fn(f: fn(elt: ?, i: number) -> ?, context?: ?) -> [!0.!ret]",
        "!effects": [
          "call !0 this=!1 !this.<i> number"
        ],
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Array/map",
        "!doc": "Creates a new array with the results of calling a provided function on every element in this array."
      },
      "reduce": {
        "!type": "fn(combine: fn(sum: ?, elt: ?, i: number) -> ?, init?: ?) -> !0.!ret",
        "!effects": [
          "call !0 !1 !this.<i> number"
        ],
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Array/Reduce",
        "!doc": "Apply a function against an accumulator and each value of the array (from left-to-right) as to reduce it to a single value."
      },
      "reduceRight": {
        "!type": "fn(combine: fn(sum: ?, elt: ?, i: number) -> ?, init?: ?) -> !0.!ret",
        "!effects": [
          "call !0 !1 !this.<i> number"
        ],
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Array/ReduceRight",
        "!doc": "Apply a function simultaneously against two values of the array (from right-to-left) as to reduce it to a single value."
      }
    },
    "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Array",
    "!doc": "The JavaScript Array global object is a constructor for arrays, which are high-level, list-like objects."
  },
  "String": {
    "!type": "fn(value: ?) -> string",
    "fromCharCode": {
      "!type": "fn(code: number) -> string",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/String/fromCharCode",
      "!doc": "Returns a string created by using the specified sequence of Unicode values."
    },
    "prototype": {
      "!stdProto": "String",
      "length": {
        "!type": "number",
        "!url": "https://developer.mozilla.org/en/docs/JavaScript/Reference/Global_Objects/String/length",
        "!doc": "Represents the length of a string."
      },
      "<i>": "string",
      "charAt": {
        "!type": "fn(i: number) -> string",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/String/charAt",
        "!doc": "Returns the specified character from a string."
      },
      "charCodeAt": {
        "!type": "fn(i: number) -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/String/charCodeAt",
        "!doc": "Returns the numeric Unicode value of the character at the given index (except for unicode codepoints > 0x10000)."
      },
      "indexOf": {
        "!type": "fn(char: string, from?: number) -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/String/indexOf",
        "!doc": "Returns the index within the calling String object of the first occurrence of the specified value, starting the search at fromIndex,\nreturns -1 if the value is not found."
      },
      "lastIndexOf": {
        "!type": "fn(char: string, from?: number) -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/String/lastIndexOf",
        "!doc": "Returns the index within the calling String object of the last occurrence of the specified value, or -1 if not found. The calling string is searched backward, starting at fromIndex."
      },
      "substring": {
        "!type": "fn(from: number, to?: number) -> string",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/String/substring",
        "!doc": "Returns a subset of a string between one index and another, or through the end of the string."
      },
      "substr": {
        "!type": "fn(from: number, length?: number) -> string",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/String/substr",
        "!doc": "Returns the characters in a string beginning at the specified location through the specified number of characters."
      },
      "slice": {
        "!type": "fn(from: number, to?: number) -> string",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/String/slice",
        "!doc": "Extracts a section of a string and returns a new string."
      },
      "trim": {
        "!type": "fn() -> string",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/String/Trim",
        "!doc": "Removes whitespace from both ends of the string."
      },
      "trimLeft": {
        "!type": "fn() -> string",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/String/TrimLeft",
        "!doc": "Removes whitespace from the left end of the string."
      },
      "trimRight": {
        "!type": "fn() -> string",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/String/TrimRight",
        "!doc": "Removes whitespace from the right end of the string."
      },
      "toUpperCase": {
        "!type": "fn() -> string",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/String/toUpperCase",
        "!doc": "Returns the calling string value converted to uppercase."
      },
      "toLowerCase": {
        "!type": "fn() -> string",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/String/toLowerCase",
        "!doc": "Returns the calling string value converted to lowercase."
      },
      "toLocaleUpperCase": {
        "!type": "fn() -> string",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/String/toLocaleUpperCase",
        "!doc": "Returns the calling string value converted to upper case, according to any locale-specific case mappings."
      },
      "toLocaleLowerCase": {
        "!type": "fn() -> string",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/String/toLocaleLowerCase",
        "!doc": "Returns the calling string value converted to lower case, according to any locale-specific case mappings."
      },
      "split": {
        "!type": "fn(pattern: string) -> [string]",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/String/split",
        "!doc": "Splits a String object into an array of strings by separating the string into substrings."
      },
      "concat": {
        "!type": "fn(other: string) -> string",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/String/concat",
        "!doc": "Combines the text of two or more strings and returns a new string."
      },
      "localeCompare": {
        "!type": "fn(other: string) -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/String/localeCompare",
        "!doc": "Returns a number indicating whether a reference string comes before or after or is the same as the given string in sort order."
      },
      "match": {
        "!type": "fn(pattern: +RegExp) -> [string]",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/String/match",
        "!doc": "Used to retrieve the matches when matching a string against a regular expression."
      },
      "replace": {
        "!type": "fn(pattern: +RegExp, replacement: string) -> string",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/String/replace",
        "!doc": "Returns a new string with some or all matches of a pattern replaced by a replacement.  The pattern can be a string or a RegExp, and the replacement can be a string or a function to be called for each match."
      },
      "search": {
        "!type": "fn(pattern: +RegExp) -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/String/search",
        "!doc": "Executes the search for a match between a regular expression and this String object."
      }
    },
    "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/String",
    "!doc": "The String global object is a constructor for strings, or a sequence of characters."
  },
  "Number": {
    "!type": "fn(value: ?) -> number",
    "MAX_VALUE": {
      "!type": "number",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Number/MAX_VALUE",
      "!doc": "The maximum numeric value representable in JavaScript."
    },
    "MIN_VALUE": {
      "!type": "number",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Number/MIN_VALUE",
      "!doc": "The smallest positive numeric value representable in JavaScript."
    },
    "POSITIVE_INFINITY": {
      "!type": "number",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Number/POSITIVE_INFINITY",
      "!doc": "A value representing the positive Infinity value."
    },
    "NEGATIVE_INFINITY": {
      "!type": "number",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Number/NEGATIVE_INFINITY",
      "!doc": "A value representing the negative Infinity value."
    },
    "prototype": {
      "!stdProto": "Number",
      "toString": {
        "!type": "fn(radix?: number) -> string",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Number/toString",
        "!doc": "Returns a string representing the specified Number object"
      },
      "toFixed": {
        "!type": "fn(digits: number) -> string",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Number/toFixed",
        "!doc": "Formats a number using fixed-point notation"
      },
      "toExponential": {
        "!type": "fn(digits: number) -> string",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Number/toExponential",
        "!doc": "Returns a string representing the Number object in exponential notation"
      }
    },
    "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Number",
    "!doc": "The Number JavaScript object is a wrapper object allowing you to work with numerical values. A Number object is created using the Number() constructor."
  },
  "Boolean": {
    "!type": "fn(value: ?) -> bool",
    "prototype": {
      "!stdProto": "Boolean"
    },
    "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Boolean",
    "!doc": "The Boolean object is an object wrapper for a boolean value."
  },
  "RegExp": {
    "!type": "fn(source: string, flags?: string)",
    "prototype": {
      "!stdProto": "RegExp",
      "exec": {
        "!type": "fn(input: string) -> [string]",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/RegExp/exec",
        "!doc": "Executes a search for a match in a specified string. Returns a result array, or null."
      },
      "compile": {
        "!type": "fn(source: string, flags?: string)",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/RegExp",
        "!doc": "Creates a regular expression object for matching text with a pattern."
      },
      "test": {
        "!type": "fn(input: string) -> bool",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/RegExp/test",
        "!doc": "Executes the search for a match between a regular expression and a specified string. Returns true or false."
      },
      "global": {
        "!type": "bool",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/RegExp",
        "!doc": "Creates a regular expression object for matching text with a pattern."
      },
      "ignoreCase": {
        "!type": "bool",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/RegExp",
        "!doc": "Creates a regular expression object for matching text with a pattern."
      },
      "multiline": {
        "!type": "bool",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/RegExp/multiline",
        "!doc": "Reflects whether or not to search in strings across multiple lines.\n"
      },
      "source": {
        "!type": "string",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/RegExp/source",
        "!doc": "A read-only property that contains the text of the pattern, excluding the forward slashes.\n"
      },
      "lastIndex": {
        "!type": "number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/RegExp/lastIndex",
        "!doc": "A read/write integer property that specifies the index at which to start the next match."
      }
    },
    "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/RegExp",
    "!doc": "Creates a regular expression object for matching text with a pattern."
  },
  "Date": {
    "!type": "fn(ms: number)",
    "parse": {
      "!type": "fn(source: string) -> +Date",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/parse",
      "!doc": "Parses a string representation of a date, and returns the number of milliseconds since January 1, 1970, 00:00:00 UTC."
    },
    "UTC": {
      "!type": "fn(year: number, month: number, date: number, hour?: number, min?: number, sec?: number, ms?: number) -> number",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/UTC",
      "!doc": "Accepts the same parameters as the longest form of the constructor, and returns the number of milliseconds in a Date object since January 1, 1970, 00:00:00, universal time."
    },
    "now": {
      "!type": "fn() -> number",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/now",
      "!doc": "Returns the number of milliseconds elapsed since 1 January 1970 00:00:00 UTC."
    },
    "prototype": {
      "toUTCString": {
        "!type": "fn() -> string",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/toUTCString",
        "!doc": "Converts a date to a string, using the universal time convention."
      },
      "toISOString": {
        "!type": "fn() -> string",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/toISOString",
        "!doc": "JavaScript provides a direct way to convert a date object into a string in ISO format, the ISO 8601 Extended Format."
      },
      "toDateString": {
        "!type": "fn() -> string",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/toDateString",
        "!doc": "Returns the date portion of a Date object in human readable form in American English."
      },
      "toTimeString": {
        "!type": "fn() -> string",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/toTimeString",
        "!doc": "Returns the time portion of a Date object in human readable form in American English."
      },
      "toLocaleDateString": {
        "!type": "fn() -> string",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/toLocaleDateString",
        "!doc": "Converts a date to a string, returning the \"date\" portion using the operating system's locale's conventions.\n"
      },
      "toLocaleTimeString": {
        "!type": "fn() -> string",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/toLocaleTimeString",
        "!doc": "Converts a date to a string, returning the \"time\" portion using the current locale's conventions."
      },
      "getTime": {
        "!type": "fn() -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/getTime",
        "!doc": "Returns the numeric value corresponding to the time for the specified date according to universal time."
      },
      "getFullYear": {
        "!type": "fn() -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/getFullYear",
        "!doc": "Returns the year of the specified date according to local time."
      },
      "getYear": {
        "!type": "fn() -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/getYear",
        "!doc": "Returns the year in the specified date according to local time."
      },
      "getMonth": {
        "!type": "fn() -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/getMonth",
        "!doc": "Returns the month in the specified date according to local time."
      },
      "getUTCMonth": {
        "!type": "fn() -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/getUTCMonth",
        "!doc": "Returns the month of the specified date according to universal time.\n"
      },
      "getDate": {
        "!type": "fn() -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/getDate",
        "!doc": "Returns the day of the month for the specified date according to local time."
      },
      "getUTCDate": {
        "!type": "fn() -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/getUTCDate",
        "!doc": "Returns the day (date) of the month in the specified date according to universal time.\n"
      },
      "getDay": {
        "!type": "fn() -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/getDay",
        "!doc": "Returns the day of the week for the specified date according to local time."
      },
      "getUTCDay": {
        "!type": "fn() -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/getUTCDay",
        "!doc": "Returns the day of the week in the specified date according to universal time.\n"
      },
      "getHours": {
        "!type": "fn() -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/getHours",
        "!doc": "Returns the hour for the specified date according to local time."
      },
      "getUTCHours": {
        "!type": "fn() -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/getUTCHours",
        "!doc": "Returns the hours in the specified date according to universal time.\n"
      },
      "getMinutes": {
        "!type": "fn() -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/getMinutes",
        "!doc": "Returns the minutes in the specified date according to local time."
      },
      "getUTCMinutes": {
        "!type": "fn() -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date",
        "!doc": "Creates JavaScript Date instances which let you work with dates and times."
      },
      "getSeconds": {
        "!type": "fn() -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/getSeconds",
        "!doc": "Returns the seconds in the specified date according to local time."
      },
      "getUTCSeconds": {
        "!type": "fn() -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/getUTCSeconds",
        "!doc": "Returns the seconds in the specified date according to universal time.\n"
      },
      "getMilliseconds": {
        "!type": "fn() -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/getMilliseconds",
        "!doc": "Returns the milliseconds in the specified date according to local time."
      },
      "getUTCMilliseconds": {
        "!type": "fn() -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/getUTCMilliseconds",
        "!doc": "Returns the milliseconds in the specified date according to universal time.\n"
      },
      "getTimezoneOffset": {
        "!type": "fn() -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/getTimezoneOffset",
        "!doc": "Returns the time-zone offset from UTC, in minutes, for the current locale."
      },
      "setTime": {
        "!type": "fn(date: +Date) -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/setTime",
        "!doc": "Sets the Date object to the time represented by a number of milliseconds since January 1, 1970, 00:00:00 UTC.\n"
      },
      "setFullYear": {
        "!type": "fn(year: number) -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/setFullYear",
        "!doc": "Sets the full year for a specified date according to local time.\n"
      },
      "setUTCFullYear": {
        "!type": "fn(year: number) -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/setUTCFullYear",
        "!doc": "Sets the full year for a specified date according to universal time.\n"
      },
      "setMonth": {
        "!type": "fn(month: number) -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/setMonth",
        "!doc": "Set the month for a specified date according to local time."
      },
      "setUTCMonth": {
        "!type": "fn(month: number) -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/setUTCMonth",
        "!doc": "Sets the month for a specified date according to universal time.\n"
      },
      "setDate": {
        "!type": "fn(day: number) -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/setDate",
        "!doc": "Sets the day of the month for a specified date according to local time."
      },
      "setUTCDate": {
        "!type": "fn(day: number) -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/setUTCDate",
        "!doc": "Sets the day of the month for a specified date according to universal time.\n"
      },
      "setHours": {
        "!type": "fn(hour: number) -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/setHours",
        "!doc": "Sets the hours for a specified date according to local time, and returns the number of milliseconds since 1 January 1970 00:00:00 UTC until the time represented by the updated Date instance."
      },
      "setUTCHours": {
        "!type": "fn(hour: number) -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/setUTCHours",
        "!doc": "Sets the hour for a specified date according to universal time.\n"
      },
      "setMinutes": {
        "!type": "fn(min: number) -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/setMinutes",
        "!doc": "Sets the minutes for a specified date according to local time."
      },
      "setUTCMinutes": {
        "!type": "fn(min: number) -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/setUTCMinutes",
        "!doc": "Sets the minutes for a specified date according to universal time.\n"
      },
      "setSeconds": {
        "!type": "fn(sec: number) -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/setSeconds",
        "!doc": "Sets the seconds for a specified date according to local time."
      },
      "setUTCSeconds": {
        "!type": "fn(sec: number) -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/setUTCSeconds",
        "!doc": "Sets the seconds for a specified date according to universal time.\n"
      },
      "setMilliseconds": {
        "!type": "fn(ms: number) -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/setMilliseconds",
        "!doc": "Sets the milliseconds for a specified date according to local time.\n"
      },
      "setUTCMilliseconds": {
        "!type": "fn(ms: number) -> number",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/setUTCMilliseconds",
        "!doc": "Sets the milliseconds for a specified date according to universal time.\n"
      }
    },
    "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date",
    "!doc": "Creates JavaScript Date instances which let you work with dates and times."
  },
  "Error": {
    "!type": "fn(message: string)",
    "prototype": {
      "name": {
        "!type": "string",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Error/name",
        "!doc": "A name for the type of error."
      },
      "message": {
        "!type": "string",
        "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Error/message",
        "!doc": "A human-readable description of the error."
      }
    },
    "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Error",
    "!doc": "Creates an error object."
  },
  "SyntaxError": {
    "!type": "fn(message: string)",
    "prototype": "Error.prototype",
    "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/SyntaxError",
    "!doc": "Represents an error when trying to interpret syntactically invalid code."
  },
  "ReferenceError": {
    "!type": "fn(message: string)",
    "prototype": "Error.prototype",
    "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/ReferenceError",
    "!doc": "Represents an error when a non-existent variable is referenced."
  },
  "URIError": {
    "!type": "fn(message: string)",
    "prototype": "Error.prototype",
    "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/URIError",
    "!doc": "Represents an error when a malformed URI is encountered."
  },
  "EvalError": {
    "!type": "fn(message: string)",
    "prototype": "Error.prototype",
    "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/EvalError",
    "!doc": "Represents an error regarding the eval function."
  },
  "RangeError": {
    "!type": "fn(message: string)",
    "prototype": "Error.prototype",
    "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/RangeError",
    "!doc": "Represents an error when a number is not within the correct range allowed."
  },
  "parseInt": {
    "!type": "fn(string: string, radix?: number) -> number",
    "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/parseInt",
    "!doc": "Parses a string argument and returns an integer of the specified radix or base."
  },
  "parseFloat": {
    "!type": "fn(string: string) -> number",
    "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/parseFloat",
    "!doc": "Parses a string argument and returns a floating point number."
  },
  "isNaN": {
    "!type": "fn(value: number) -> bool",
    "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/isNaN",
    "!doc": "Determines whether a value is NaN or not. Be careful, this function is broken. You may be interested in ECMAScript 6 Number.isNaN."
  },
  "eval": {
    "!type": "fn(code: string) -> ?",
    "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/eval",
    "!doc": "Evaluates JavaScript code represented as a string."
  },
  "encodeURI": {
    "!type": "fn(uri: string) -> string",
    "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/encodeURI",
    "!doc": "Encodes a Uniform Resource Identifier (URI) by replacing each instance of certain characters by one, two, three, or four escape sequences representing the UTF-8 encoding of the character (will only be four escape sequences for characters composed of two \"surrogate\" characters)."
  },
  "encodeURIComponent": {
    "!type": "fn(uri: string) -> string",
    "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/encodeURIComponent",
    "!doc": "Encodes a Uniform Resource Identifier (URI) component by replacing each instance of certain characters by one, two, three, or four escape sequences representing the UTF-8 encoding of the character (will only be four escape sequences for characters composed of two \"surrogate\" characters)."
  },
  "decodeURI": {
    "!type": "fn(uri: string) -> string",
    "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/decodeURI",
    "!doc": "Decodes a Uniform Resource Identifier (URI) previously created by encodeURI or by a similar routine."
  },
  "decodeURIComponent": {
    "!type": "fn(uri: string) -> string",
    "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/decodeURIComponent",
    "!doc": "Decodes a Uniform Resource Identifier (URI) component previously created by encodeURIComponent or by a similar routine."
  },
  "Math": {
    "E": {
      "!type": "number",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Math/E",
      "!doc": "The base of natural logarithms, e, approximately 2.718."
    },
    "LN2": {
      "!type": "number",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Math/LN2",
      "!doc": "The natural logarithm of 2, approximately 0.693."
    },
    "LN10": {
      "!type": "number",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Math/LN10",
      "!doc": "The natural logarithm of 10, approximately 2.302."
    },
    "LOG2E": {
      "!type": "number",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Math/LOG2E",
      "!doc": "The base 2 logarithm of E (approximately 1.442)."
    },
    "LOG10E": {
      "!type": "number",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Math/LOG10E",
      "!doc": "The base 10 logarithm of E (approximately 0.434)."
    },
    "SQRT1_2": {
      "!type": "number",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Math/SQRT1_2",
      "!doc": "The square root of 1/2; equivalently, 1 over the square root of 2, approximately 0.707."
    },
    "SQRT2": {
      "!type": "number",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Math/SQRT2",
      "!doc": "The square root of 2, approximately 1.414."
    },
    "PI": {
      "!type": "number",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Math/PI",
      "!doc": "The ratio of the circumference of a circle to its diameter, approximately 3.14159."
    },
    "abs": {
      "!type": "fn(number) -> number",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Math/abs",
      "!doc": "Returns the absolute value of a number."
    },
    "cos": {
      "!type": "fn(number) -> number",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Math/cos",
      "!doc": "Returns the cosine of a number."
    },
    "sin": {
      "!type": "fn(number) -> number",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Math/sin",
      "!doc": "Returns the sine of a number."
    },
    "tan": {
      "!type": "fn(number) -> number",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Math/tan",
      "!doc": "Returns the tangent of a number."
    },
    "acos": {
      "!type": "fn(number) -> number",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Math/acos",
      "!doc": "Returns the arccosine (in radians) of a number."
    },
    "asin": {
      "!type": "fn(number) -> number",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Math/asin",
      "!doc": "Returns the arcsine (in radians) of a number."
    },
    "atan": {
      "!type": "fn(number) -> number",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Math/atan",
      "!doc": "Returns the arctangent (in radians) of a number."
    },
    "atan2": {
      "!type": "fn(y: number, x: number) -> number",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Math/atan2",
      "!doc": "Returns the arctangent of the quotient of its arguments."
    },
    "ceil": {
      "!type": "fn(number) -> number",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Math/ceil",
      "!doc": "Returns the smallest integer greater than or equal to a number."
    },
    "floor": {
      "!type": "fn(number) -> number",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Math/floor",
      "!doc": "Returns the largest integer less than or equal to a number."
    },
    "round": {
      "!type": "fn(number) -> number",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Math/round",
      "!doc": "Returns the value of a number rounded to the nearest integer."
    },
    "exp": {
      "!type": "fn(number) -> number",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Math/exp",
      "!doc": "Returns Ex, where x is the argument, and E is Euler's constant, the base of the natural logarithms."
    },
    "log": {
      "!type": "fn(number) -> number",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Math/log",
      "!doc": "Returns the natural logarithm (base E) of a number."
    },
    "sqrt": {
      "!type": "fn(number) -> number",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Math/sqrt",
      "!doc": "Returns the square root of a number."
    },
    "pow": {
      "!type": "fn(number, number) -> number",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Math/pow",
      "!doc": "Returns base to the exponent power, that is, baseexponent."
    },
    "max": {
      "!type": "fn(number, number) -> number",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Math/max",
      "!doc": "Returns the largest of zero or more numbers."
    },
    "min": {
      "!type": "fn(number, number) -> number",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Math/min",
      "!doc": "Returns the smallest of zero or more numbers."
    },
    "random": {
      "!type": "fn() -> number",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Math/random",
      "!doc": "Returns a floating-point, pseudo-random number in the range [0, 1) that is, from 0 (inclusive) up to but not including 1 (exclusive), which you can then scale to your desired range."
    },
    "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Math",
    "!doc": "A built-in object that has properties and methods for mathematical constants and functions."
  },
  "JSON": {
    "parse": {
      "!type": "fn(json: string) -> ?",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/JSON/parse",
      "!doc": "Parse a string as JSON, optionally transforming the value produced by parsing."
    },
    "stringify": {
      "!type": "fn(value: ?) -> string",
      "!url": "https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/JSON/stringify",
      "!doc": "Convert a value to JSON, optionally replacing values if a replacer function is specified, or optionally including only the specified properties if a replacer array is specified."
    },
    "!url": "https://developer.mozilla.org/en-US/docs/JSON",
    "!doc": "JSON (JavaScript Object Notation) is a data-interchange format.  It closely resembles a subset of JavaScript syntax, although it is not a strict subset. (See JSON in the JavaScript Reference for full details.)  It is useful when writing any kind of JavaScript-based application, including websites and browser extensions.  For example, you might store user information in JSON format in a cookie, or you might store extension preferences in JSON in a string-valued browser preference."
  }
}

var tern_lodash = {
  "!name": "lodash",
  "_": {
    "!doc": "Save the previous value of the `_` variable.",
    "!type": "fn(obj: ?) -> +_",
    "VERSION": {
      "!type": "string",
      "!url": "http://lodash.com/docs#VERSION"
    },
    "after": {
      "!doc": "Returns a function that will only be executed after being called N times.",
      "!url": "http://lodash.com/docs#after",
      "!type": "fn(times: number, func: fn()) -> !1"
    },
    "all": "_.every",
    "any": "_.some",
    "assign": "_.extend",
    "at": {
       "!doc": "Creates an array of elements from the specified indexes, or keys, of the collection. Indexes may be specified as individual arguments or as arrays of indexes.",
       "!url": "http://lodash.com/docs#at",
       "!type": "fn(collection: [?], index?: ?) -> [?]"
    },
    "bind": {
      "!doc": "Create a function bound to a given object (assigning `this`, and arguments, optionally).",
      "!type": "fn(func: ?, context?: ?, args?: ?) -> !0",
      "!url": "http://lodash.com/docs#bind"
    },
    "bindAll": {
      "!doc": "Bind all of an object's methods to that object.",
      "!type": "fn(obj: ?, names?: [string])",
      "!url": "http://lodash.com/docs#bindAll"
    },
    "bindKey": {
      "!doc": "Creates a function that, when called, invokes the method at object[key] and prepends any additional bindKey arguments to those provided to the bound function. This method differs from _.bind by allowing bound functions to reference methods that will be redefined or don't yet exist.",
      "!type": "fn(object: ?, key: string, arg?: ?) -> !0",
      "!url": "http://lodash.com/docs#bindKey"
    },
    "chain": {
      "!doc": "Add a \"chain\" function, which will delegate to the wrapper.",
      "!type": "fn(obj: ?)",
      "!url": "http://lodash.com/docs#chain"
    },
    "clone": {
      "!doc": "Create a (shallow-cloned) duplicate of an object.",
      "!type": "fn(value: ?, isDeep?: bool, callback?: fn(value: ?) -> ?, thisArg: !0) -> !0",
      "!url": "http://lodash.com/docs#clone"
    },
    "cloneDeep": {
      "!doc": "Create a (deep-cloned) duplicate of an object.",
      "!type": "fn(value: ?, callback?: fn(value: ?) -> ?, thisArg: !0) -> !0",
      "!url": "http://lodash.com/docs#cloneDeep"
    },
    "collect": "_.map",
    "compact": {
      "!doc": "Trim out all falsy values from an array.",
      "!type": "fn(array: [?]) -> [?]",
      "!url": "http://lodash.com/docs#compact"
    },
    "compose": {
      "!doc": "Returns a function that is the composition of a list of functions, each consuming the return value of the function that follows.",
      "!type": "fn(a: fn(), b: fn()) -> fn() -> !1.!ret",
      "!url": "http://lodash.com/docs#compose"
    },
    "contains": {
      "!doc": "Determine if the array or object contains a given value (using `===`).",
      "!type": "fn(collection: [?], target: ?, fromIndex?: number) -> bool",
      "!url": "http://lodash.com/docs#contains"
    },
    "countBy": {
      "!doc": "Counts instances of an object that group by a certain criterion.",
      "!type": "fn(obj: ?, iterator: fn(elt: ?, i: number) -> ?, context?: ?) -> ?",
      "!url": "http://lodash.com/docs#countBy"
    },
    "create": {
      "!doc": "Creates an object that inherits from the given prototype object.",
      "!type": "fn(prototype: object, properties?: object) -> !0",
      "!url": "http://lodash.com/docs#create"
    },
    "createCallback": {
      "!doc": "Produces a callback bound to an optional thisArg",
      "!type": "fn(func?: fn(), thisArg?: !0, argCount?: number) -> fn()",
      "!url": "http://lodash.com/docs#createCallback"
    },
    "curry": {
      "!doc": "Creates a function which accepts one or more arguments of func that when invoked either executes func returning its result, if all func arguments have been provided, or returns a function that accepts one or more of the remaining func arguments, and so on.",
      "!type": "fn(func: fn(), arity: number) -> fn()",
      "!url": "http://lodash.com/docs#curry"
    },
    "debounce": {
      "!doc": "Returns a function, that, as long as it continues to be invoked, will not be triggered.",
      "!type": "fn(func: fn(), wait: number, options?: ?) -> !0",
      "!url": "http://lodash.com/docs#debounce"
    },
    "defaults": {
      "!doc": "Fill in a given object with default properties.",
      "!type": "fn(obj: ?, defaults: ?) -> !0",
      "!effects": ["copy !1 !0"],
      "!url": "http://lodash.com/docs#defaults"
    },
    "defer": {
      "!doc": "Defers a function, scheduling it to run after the current call stack has cleared.",
      "!type": "fn(func: fn(), args?: ?) -> number",
      "!url": "http://lodash.com/docs#defer"
    },
    "delay": {
      "!doc": "Delays a function for the given number of milliseconds, and then calls it with the arguments supplied.",
      "!type": "fn(func: fn(), wait: number, args?: ?) -> number",
      "!url": "http://lodash.com/docs#delay"
    },
    "detect": "_.find",
    "difference": {
      "!doc": "Take the difference between one array and a number of other arrays.",
      "!type": "fn(array: [?], others?: [?]) -> !0",
      "!url": "http://lodash.com/docs#difference"
    },
    "drop": "_.rest",
    "each": {
      "!doc": "Iterates over a list of elements, yielding each in turn to an iterator function.",
      "!type": "fn(collection: [?], callback?: fn(value: ?, index: number), thisArg?: !0) -> [?]",
      "!url": "http://lodash.com/docs#forEach"
    },
    "eachRight": "forEachRight",
    "escape": {
      "!doc": "Escapes a string for insertion into HTML.",
      "!type": "fn(string) -> string",
      "!url": "http://lodash.com/docs#escape"
    },
    "every": {
      "!doc": "Determine whether all of the elements match a truth test.",
      "!type": "fn(list: [?], iterator: fn(elt: ?, i: number) -> bool, context?: ?) -> bool",
      "!effects": ["call !1 this=!2 !0.<i> number"],
      "!url": "http://lodash.com/docs#every"
    },
    "extend": {
      "!doc": "Extend a given object with all the properties in passed-in object(s).",
      "!type": "fn(destination: ?, source1: ?, source2?: ?) -> !0",
      "!effects": ["copy !1 !0", "copy !2 !0"],
      "!url": "http://lodash.com/docs#extend"
    },
    "filter": {
      "!doc": "Looks through each value in the list, returning an array of all the values that pass a truth test.",
      "!type": "fn(list: [?], test: fn(value: ?, index: number) -> bool, context?: ?) -> !0",
      "!effects": ["call !1 this=!2 !0.<i> number"],
      "!url": "http://lodash.com/docs#filter"
    },
    "find": {
      "!doc": "Return the first value which passes a truth test.",
      "!type": "fn(list: [?], test: fn(?) -> bool, context?: ?) -> !0.<i>",
      "!effects": ["call !1 !0.<i>"],
      "!url": "http://lodash.com/docs#find"
    },
    "findIndex": {
      "!doc": "This method is like _.find except that it returns the index of the first element that passes the callback check, instead of the element itself.",
      "!type": "fn([?], callback?: fn(?) -> bool, thisArg?: !0) -> number",
      "!url": "http://lodash.com/docs#findIndex"
    },
    "findKey": {
      "!doc": "This method is like _.findIndex except that it returns the key of the first element that passes the callback check, instead of the element itself.",
      "!type": "fn(object: ?, callback?: fn(?) -> bool, thisArg: !0) -> ?",
      "!url": "http://lodash.com/docs#findKey"
    },
    "findLast": {
      "!doc": "This method is like _.find except that it iterates over elements of a collection from right to left.",
      "!type": "fn(collection: ?, callback?: ?, thisArg?: !0) -> !0.<i> -> undefined",
      "!url": "http://lodash.com/docs#findLast"
    },
    "findLastIndex": {
      "!doc": "This method is like _.findIndex except that it iterates over elements of a collection from right to left.",
      "!type": "fn(array: [?], callback?: ?, thisArg?: !0) -> number",
      "!url": "http://lodash.com/docs#findLastIndex"
    },
    "findLastKey": {
      "!doc": "This method is like _.findKey except that it iterates over elements of a collection in the opposite order.",
      "!type": "fn(object: ?, callback?: ?, thisArg?: !0) -> string -> undefined",
      "!url": "http://lodash.com/docs#findLastKey"
    },
    "findWhere": {
      "!doc": "Looks through the list and returns the first value that matches all of the key-value pairs listed in properties.",
      "!type": "fn(list: [?], attrs: ?) -> !0.<i>",
      "!url": "http://lodash.com/docs#findWhere"
    },
    "first": {
      "!doc": "Get the first element of an array. Passing n will return the first N values in the array.",
      "!type": "fn(array: [?], callback?: ?, thisArg?: ?) -> !0.<i>",
      "!url": "http://lodash.com/docs#first"
    },
    "flatten": {
      "!doc": "Return a completely flattened version of an array.",
      "!type": "fn(array: [?], shallow?: bool) -> [?]",
      "!url": "http://lodash.com/docs#flatten"
    },
    "foldl": "_.reduce",
    "foldr": "_.reduceRight",
    "forEach": "_.each",
    "forEachRight": {
      "!doc": "This method is like _.forEach except that it iterates over elements of a collection from right to left.",
      "!type": "fn(collection: ?, callback?: fn(object: ?), thisArg?: !0) -> [?]",
      "!url": "http://lodash.com/docs#forEachRight"
    },
    "forIn": {
      "!doc": "Iterates over own and inherited enumerable properties of an object, executing the callback for each property. The callback is bound to thisArg and invoked with three arguments; (value, key, object). Callbacks may exit iteration early by explicitly returning false.",
      "!type": "fn(object: ?, callback?: fn(value: ?, key: string, object: ?), thisArg?: !0) -> ?",
      "!url": "http://lodash.com/docs#forIn"
    },
    "forInRight": {
      "!doc": "This method is like _.forIn except that it iterates over elements of a collection in the opposite order.",
      "!type": "fn(object: ?, callback?: fn(value: ?, key: string, object: ?), thisArg?: !0) -> ?",
      "!url": "http://lodash.com/docs#forInRight"
    },
    "forOwn": {
      "!doc": "Iterates over own enumerable properties of an object, executing the callback for each property. The callback is bound to thisArg and invoked with three arguments; (value, key, object). Callbacks may exit iteration early by explicitly returning false.",
      "!type": "fn(object: [?], callback?: fn(value: ?, key: string, object: ?) -> bool, thisArg?: !0)",
      "!url": "http://lodash.com/docs#forOwn"
    },
    "forOwnRight": {
      "!doc": "This method is like _.forOwn except that it iterates over elements of a collection in the opposite order.",
      "!type": "fn(object: [?], callback?: fn(value: ?, key: string, object: ?) -> bool, thisArg?: !0)",
      "!url": "http://lodash.com/docs#forOwnRight"
    },
    "functions": {
      "!doc": "Return a sorted list of the function names available on the object.",
      "!type": "fn(obj: _) -> [string]",
      "!url": "http://lodash.com/docs#functions"
    },
    "groupBy": {
      "!doc": "Groups the object's values by a criterion.",
      "!type": "fn(obj: [?], iterator: fn(elt: ?, i: number) -> ?, context?: ?) -> ?",
      "!url": "http://lodash.com/docs#groupBy"
    },
    "has": {
      "!doc": "Shortcut function for checking if an object has a given property directly on itself (in other words, not on a prototype).",
      "!type": "fn(obj: ?, key: string) -> bool",
      "!url": "http://lodash.com/docs#has"
    },
    "head": "_.first",
    "identity": {
      "!doc": "Returns the same value that is used as the argument.",
      "!type": "fn(value: ?) -> !0",
      "!url": "http://lodash.com/docs#identity"
    },
    "include": "_.contains",
    "indexOf": {
      "!doc": "Returns the index at which value can be found in the array, or -1 if value is not present in the array.",
      "!type": "fn(list: [?], item: ?, isSorted?: bool) -> number",
      "!url": "http://lodash.com/docs#indexOf"
    },
    "initial": {
      "!doc": "Returns everything but the last entry of the array.",
      "!type": "fn(array: [?], callback?: ?, thisArg?: !0) -> !0",
      "!url": "http://lodash.com/docs#initial"
    },
    "inject": "_.reduce",
    "intersection": {
      "!doc": "Produce an array that contains every item shared between all the passed-in arrays.",
      "!type": "fn(array: [?], others?: [?]) -> !0",
      "!url": "http://lodash.com/docs#intersection"
    },
    "invert": {
      "!doc": "Invert the keys and values of an object.",
      "!type": "fn(obj: ?) -> ?",
      "!url": "http://lodash.com/docs#invert"
    },
    "invoke": {
      "!doc": "Invoke a method (with arguments) on every item in a collection.",
      "!type": "fn(obj: ?, method: string, args?: ?) -> [?]",
      "!url": "http://lodash.com/docs#invoke"
    },
    "isArguments": {
      "!doc": "Returns true if object is an Arguments object.",
      "!type": "fn(obj: ?) -> bool",
      "!url": "http://lodash.com/docs#isArguments"
    },
    "isArray": {
      "!doc": "Is a given value an array? Delegates to ECMA5's native Array.isArray",
      "!type": "fn(obj: ?) -> bool",
      "!url": "http://lodash.com/docs#isArray"
    },
    "isBoolean": {
      "!doc": "Is a given value a boolean?",
      "!type": "fn(obj: ?) -> bool",
      "!url": "http://lodash.com/docs#isBoolean"
    },
    "isDate": {
      "!doc": "Returns true if object is a Date object.",
      "!type": "fn(obj: ?) -> bool",
      "!url": "http://lodash.com/docs#isDate"
    },
    "isElement": {
      "!doc": "Is a given value a DOM element?",
      "!type": "fn(obj: ?) -> bool",
      "!url": "http://lodash.com/docs#isElement"
    },
    "isEmpty": {
      "!doc": "Is a given array, string, or object empty? An \"empty\" object has no enumerable own-properties.",
      "!type": "fn(obj: ?) -> bool",
      "!url": "http://lodash.com/docs#isEmpty"
    },
    "isEqual": {
      "!doc": "Perform a deep comparison to check if two objects are equal.",
      "!type": "fn(a: ?, b: ?, callback?: fn(a: ?, b: ?) -> bool, thisArg?: !0) -> bool",
      "!url": "http://lodash.com/docs#isEqual"
    },
    "isFinite": {
      "!doc": "Is a given object a finite number?",
      "!type": "fn(obj: ?) -> bool",
      "!url": "http://lodash.com/docs#isFinite"
    },
    "isFunction": {
      "!doc": "Returns true if object is a Function.",
      "!type": "fn(obj: ?) -> bool",
      "!url": "http://lodash.com/docs#isFunction"
    },
    "isNaN": {
      "!doc": "Is the given value `NaN`? (NaN is the only number which does not equal itself).",
      "!type": "fn(obj: ?) -> bool",
      "!url": "http://lodash.com/docs#isNaN"
    },
    "isNull": {
      "!doc": "Is a given value equal to null?",
      "!type": "fn(obj: ?) -> bool",
      "!url": "http://lodash.com/docs#isNull"
    },
    "isNumber": {
      "!doc": "Returns true if object is a Number (including NaN).",
      "!type": "fn(obj: ?) -> bool",
      "!url": "http://lodash.com/docs#isNumber"
    },
    "isObject": {
      "!doc": "Is a given variable an object?",
      "!type": "fn(obj: ?) -> bool",
      "!url": "http://lodash.com/docs#isObject"
    },
    "isPlainObject": {
      "!doc": "Checks if value is an object created by the Object constructor.",
      "!type": "fn(value: ?) -> bool",
      "!url": "http://lodash.com/docs#isPlainObject"
    },
    "isRegExp": {
      "!doc": "Returns true if object is a regular expression.",
      "!type": "fn(obj: ?) -> bool",
      "!url": "http://lodash.com/docs#isRegExp"
    },
    "isString": {
      "!doc": "Returns true if object is a String.",
      "!type": "fn(obj: ?) -> bool",
      "!url": "http://lodash.com/docs#isString"
    },
    "isUndefined": {
      "!doc": "Is a given variable undefined?",
      "!type": "fn(obj: ?) -> bool",
      "!url": "http://lodash.com/docs#isUndefined"
    },
    "keys": {
      "!doc": "Retrieve the names of an object's properties. Delegates to ECMAScript 5's native `Object.keys`",
      "!type": "fn(obj: ?) -> [string]",
      "!url": "http://lodash.com/docs#keys"
    },
    "last": {
      "!doc": "Get the last element of an array.",
      "!type": "fn(array: [?], callback?: ?, thisArg?: !0) -> !0.<i>",
      "!url": "http://lodash.com/docs#last"
    },
    "lastIndexOf": {
      "!doc": "Returns the index of the last occurrence of value in the array, or -1 if value is not present.",
      "!type": "fn(array: [?], item: ?, from?: number) -> number",
      "!url": "http://lodash.com/docs#lastIndexOf"
    },
    "map": {
      "!doc": "Produces a new array of values by mapping each value in list through a transformation function (iterator).",
      "!type": "fn(obj: [?], iterator: fn(elt: ?, i: number) -> ?, context?: ?) -> [!1.!ret]",
      "!effects": ["call !1 !this=!2 !0.<i> number"],
      "!url": "http://lodash.com/docs#map"
    },
    "mapValues": {
      "!doc": "Creates an object with the same keys as object and values generated by running each own enumerable property of object through the callback. The callback is bound to thisArg and invoked with three arguments; (value, key, object).",
      "!type": "fn(object: ?, callback?: fn(value: ?, key: ?, object?: ?) -> ?, thisArg?: !0) -> ?",
      "!url": "http://lodash.com/docs#mapValues"
    },
    "max": {
      "!doc": "Returns the maximum value in list.",
      "!type": "fn(list: [?], iterator?: fn(elt: ?, i: number) -> number, context?: ?) -> number",
      "!url": "http://lodash.com/docs#max"
    },
    "memoize": {
      "!doc": "Memoize an expensive function by storing its results.",
      "!type": "fn(func: fn(), resolver?: fn(args: ?) -> ?) -> !0",
      "!url": "http://lodash.com/docs#memoize"
    },
    "merge": {
      "!doc": "Recursively merges own enumerable properties of the source object(s), that don't resolve to undefined into the destination object.",
      "!type": "fn(object: ?, source?: ?, callback?: fn(objectValue: ?, sourceValue: ?) -> ?, thisArg?: !0) -> !0",
      "!url": "http://lodash.com/docs#merge"
    },
    "methods": "_.functions",
    "min": {
      "!doc": "Returns the minimum value in list.",
      "!type": "fn(list: [?], iterator?: fn(elt: ?, i: number) -> number, context?: ?) -> number",
      "!url": "http://lodash.com/docs#min"
    },
    "mixin": {
      "!doc": "Adds function properties of a source object to the destination object. If object is a function methods will be added to its prototype as well.",
      "!type": "fn(object?: ?, source: ?, options?: ?)",
      "!url": "http://lodash.com/docs#mixin"
    },
    "noConflict": {
      "!doc": "Reverts the '_' variable to its previous value and returns a reference to the lodash function.",
      "!type": "fn() -> _",
      "!url": "http://lodash.com/docs#noConflict"
    },
    "noop": {
      "!doc": "A no-operation function.",
      "!type": "fn() -> undefined",
      "!url": "http://lodash.com/docs#noop"
    },
    "object": {
      "!doc": "Converts lists into objects.",
      "!type": "fn(list: [?], values?: [?]) -> ?",
      "!url": "http://lodash.com/docs#object"
    },
    "omit": {
      "!doc": "Return a copy of the object without the blacklisted properties.",
      "!type": "fn(object: ?, callback?: ?, thisArg?: !0) -> !0",
      "!url": "http://lodash.com/docs#omit"
    },
    "once": {
      "!doc": "Returns a function that will be executed at most one time, no matter how often you call it.",
      "!type": "fn(func: fn() -> ?) -> !0",
      "!url": "http://lodash.com/docs#once"
    },
    "pairs": {
      "!doc": "Convert an object into a list of `[key, value]` pairs.",
      "!type": "fn(obj: ?) -> [[?]]",
      "!url": "http://lodash.com/docs#pairs"
    },
    "parseInt": {
      "!doc": "Converts the given value into an integer of the specified radix.",
      "!type": "fn(value: string, radix?: number) -> number",
      "!url": "http://lodash.com/docs#parseInt"
    },
    "partial": {
      "!doc": "Partially apply a function by creating a version that has had some of its arguments pre-filled, without changing its dynamic `this` context.",
      "!type": "fn(func: ?, args?: ?) -> fn()",
      "!url": "http://lodash.com/docs#partial"
    },
    "partialRight": {
      "!doc": "This method is like _.partial except that partial arguments are appended to those provided to the new function.",
      "!type": "fn(func: ?, args?: ?) -> fn()",
      "!url": "http://lodash.com/docs#partialRight"
    },
    "pick": {
      "!doc": "Return a copy of the object only containing the whitelisted properties.",
      "!type": "fn(object: ?, callback?: ?, thisArg?: !0) -> !0",
      "!url": "http://lodash.com/docs#pick"
    },
    "pluck": {
      "!doc": "Convenience version of a common use case of `map`: fetching a property.",
      "!type": "fn(obj: [?], key: string) -> [?]",
      "!url": "http://lodash.com/docs#pluck"
    },
    "prototype.chain": {
      "chain": {
        "!doc": "Enables explicit method chaining on the wrapper object.",
        "!type": "fn() -> !this",
        "!url": "http://lodash.com/docs#prototype_chain"
      },
      "prototype.toString": {
        "!doc": "Produces the toString result of the wrapped value.",
        "!type": "fn() -> string",
        "!url": "http://lodash.com/docs#prototype_toString"
      },
      "prototype.value": "_.prototype.valueOf",
      "prototype.valueOf": {
        "!doc": "Extracts the wrapped value.",
        "!type": "fn() -> !0",
        "!url": "http://lodash.com/docs#prototype_valueOf"
      },
      "value": {
        "!doc": "Extracts the result from a wrapped and chained object.",
        "!type": "fn() -> ?"
      },
      "pop": "fn() -> ?",
      "push": "fn(newelt: ?) -> number",
      "reverse": "fn()",
      "shift": "fn() -> ?",
      "sort": "fn() -> !this",
      "splice": "fn(pos: number, amount: number)",
      "unshift": "fn(elt: ?) -> number",
      "concat": "fn(other: ?) -> !this",
      "join": "fn(separator?: string) -> string",
      "slice": "fn(from: number, to?: number) -> !this"
    },
    "pull": {
      "!doc": "Removes all provided values from the given array using strict equality for comparisons, i.e. ===.",
      "!type": "fn(array: [?], value?: ?) -> [?]",
      "!url": "http://lodash.com/docs#pull"
    },
    "random": {
      "!doc": "Return a random integer between min and max (inclusive).",
      "!type": "fn(min?: number, max?: number, floating?: bool) -> number",
      "!url": "http://lodash.com/docs#random"
    },
    "range": {
      "!doc": "A function to create flexibly-numbered lists of integers.",
      "!type": "fn(start?: number, stop: number, step?: number) -> [number]",
      "!url": "http://lodash.com/docs#range"
    },
    "reduce": {
      "!doc": "reduce boils down a list of values into a single value.",
      "!type": "fn(list: [?], iterator: fn(sum: ?, elt: ?, i: number) -> ?, init?: ?, context?: ?) -> !1.!ret",
      "!effects": ["call !1 this=!3 !2 !0.<i> number"],
      "!url": "http://lodash.com/docs#reduce"
    },
    "reduceRight": {
      "!doc": "The right-associative version of reduce, also known as `foldr`.",
      "!type": "fn(list: [?], iterator: fn(sum: ?, elt: ?, i: number) -> ?, init?: ?, context?: ?) -> !1.!ret",
      "!effects": ["call !1 this=!3 !2 !0.<i> number"],
      "!url": "http://lodash.com/docs#reduceRight"
    },
    "reject": {
      "!doc": "Returns the values in list without the elements that the truth test (iterator) passes. The opposite of filter.",
      "!type": "fn(list: [?], iterator: fn(elt: ?, i: number) -> bool, context?: ?) -> !0",
      "!effects": ["call !1 this=!3 !0.<i> number"],
      "!url": "http://lodash.com/docs#reject"
    },
    "remove": {
      "!doc": "Removes all elements from an array that the callback returns truey for and returns an array of removed elements.",
      "!type": "fn(array: [?], callback?: ?, thisArg?: !0) -> [?]",
      "!url": "http://lodash.com/docs#remove"
    },
    "rest": {
      "!doc": "Returns the rest of the elements in an array.",
      "!type": "fn(array: [?], callback?: ?, thisArg?: !0) -> !0",
      "!url": "http://lodash.com/docs#rest"
    },
    "result": {
      "!doc": "If the value of the named `property` is a function then invoke it with the `object` as context; otherwise, return it.",
      "!type": "fn(object: ?, property: string) -> !0.<i>",
      "!url": "http://lodash.com/docs#result"
    },
    "runInContext": {
      "!doc": "Create a new lodash function using the given context object.",
      "!type": "fn(context?: ?) -> fn()",
      "!url": "http://lodash.com/docs#runInContext"
    },
    "select": "_.filter",
    "shuffle": {
      "!doc": "Shuffle an array.",
      "!type": "fn(list: [?]) -> !0",
      "!url": "http://lodash.com/docs#shuffle"
    },
    "size": {
      "!doc": "Return the number of elements in an object.",
      "!type": "fn(obj: ?) -> number",
      "!url": "http://lodash.com/docs#size"
    },
    "some": {
      "!doc": "Returns true if any of the values in the list pass the iterator truth test.",
      "!type": "fn(list: [?], iterator: fn(elt: ?, i: number) -> bool, context?: ?) -> bool",
      "!effects": ["call !1 this=!2 !0.<i> number"],
      "!url": "http://lodash.com/docs#some"
    },
    "sortBy": {
      "!doc": "Creates an array of elements, sorted in ascending order by the results of running each element in a collection through the callback.",
      "!type": "fn(collection: [?], callback: fn(elt: ?, i: number) -> number, thisArg?: ?) -> !0",
      "!url": "http://lodash.com/docs#sortBy"
    },
    "sortedIndex": {
      "!doc": "Use a comparator function to figure out the smallest index at which an object should be inserted so as to maintain order.",
      "!type": "fn(array: [?], obj: ?, iterator: fn(elt: ?, i: number), context?: ?) -> number",
      "!url": "http://lodash.com/docs#sortedIndex"
    },
    "support": {
      "!doc": "An object used to flag environments features.",
      "!type": "fn(object: ?) -> bool",
      "!url": "http://lodash.com/docs#support"
    },
    "tail": "_.rest",
    "take": "_.first",
    "tap": {
      "!doc": "Invokes interceptor with the obj, and then returns obj.",
      "!type": "fn(obj: ?, interceptor: fn()) -> !0",
      "!effects": ["call !1 !0"],
      "!url": "http://lodash.com/docs#tap"
    },
    "template": {
      "!doc": "A micro-templating method that handles arbitrary delimiters, preserves whitespace, and correctly escapes quotes within interpolated code.",
      "!type": "fn(text: string, data?: ?, options?: ?) -> fn(data: ?) -> string",
      "!url": "http://lodash.com/docs#template"
    },
    "templateSettings.imports._": {
      "!doc": "A reference to the lodash function.",
      "!url": "http://lodash.com/docs#templateSettings_imports__"
    },
    "throttle": {
      "!doc": "Returns a function, that, when invoked, will only be triggered at most once during a given window of time.",
      "!type": "fn(func: fn(), wait: number, options?: ?) -> !0",
      "!url": "http://lodash.com/docs#throttle"
    },
    "times": {
      "!doc": "Run a function n times.",
      "!type": "fn(n: number, iterator: fn(), context?: ?) -> [!1.!ret]",
      "!url": "http://lodash.com/docs#times"
    },
    "toArray": {
      "!doc": "Safely create a real, live array from anything iterable.",
      "!type": "fn(collection: ?) -> [?]",
      "!url": "http://lodash.com/docs#toArray"
    },
    "transform": {
      "!doc": "An alternative to _.reduce this method transforms object to a new accumulator object which is the result of running each of its own enumerable properties through a callback, with each callback execution potentially mutating the accumulator object.",
      "!type": "fn(object: ?, callback: fn(accumulator: ?, value: ?, key?: ?, object?: ?), accumulator?: ?, thisArg: !0) -> ?",
      "!url": "http://lodash.com/docs#transform"
    },
    "unescape": {
      "!doc": "The opposite of escape.",
      "!type": "fn(string) -> string",
      "!url": "http://lodash.com/docs#unescape"
    },
    "union": {
      "!doc": "Produce an array that contains the union: each distinct element from all of the passed-in arrays.",
      "!type": "fn(array: [?], array2: [?]) -> ?0",
      "!url": "http://lodash.com/docs#union"
    },
    "uniq": {
      "!doc": "Produce a duplicate-free version of the array.",
      "!type": "fn(array: [?], isSorted?: bool, iterator?: fn(elt: ?, i: number), context?: ?) -> [?]",
      "!url": "http://lodash.com/docs#uniq"
    },
    "unique": "_.uniq",
    "uniqueId": {
      "!doc": "Generate a unique integer id (unique within the entire client session). Useful for temporary DOM ids.",
      "!type": "fn(prefix: string) -> string",
      "!url": "http://lodash.com/docs#uniqueId"
    },
    "values": {
      "!doc": "Retrieve the values of an object's properties.",
      "!type": "fn(obj: ?) -> [!0.<i>]",
      "!url": "http://lodash.com/docs#values"
    },
    "where": {
      "!doc": "Looks through each value in the list, returning an array of all the values that contain all of the key-value pairs listed in properties.",
      "!type": "fn(collection: [?], props: ?) -> !0",
      "!url": "http://lodash.com/docs#where"
    },
    "without": {
      "!doc": "Return a version of the array that does not contain the specified value(s).",
      "!type": "fn(array: [?], values: [?]) -> !0",
      "!url": "http://lodash.com/docs#without"
    },
    "wrap": {
      "!doc": "Returns the first function passed as an argument to the second, allowing you to adjust arguments, run code before and after, and conditionally execute the original function.",
      "!type": "fn(func: fn(), wrapper: fn(?)) -> !0",
      "!effects": ["call !1 !0"],
      "!url": "http://lodash.com/docs#wrap"
    },
    "xor": {
      "!doc": "Creates an array that is the symmetric difference of the provided arrays.",
      "!type": "fn(array: [number]) -> [number]",
      "!url": "http://lodash.com/docs#xor"
    },
    "zip": {
      "!doc": "Zip together multiple lists into a single array -- elements that share an index go together.",
      "!type": "fn(array1: [?], array2: [?]) -> [?]",
      "!url": "http://lodash.com/docs#zip"
    }
  }
}

var tern_underscore = {
  "!name": "underscore",
  "_": {
    "!doc": "Save the previous value of the `_` variable.",
    "!type": "fn(obj: ?) -> +_",
    "VERSION": {
      "!type": "string",
      "!url": "http://underscorejs.org/#VERSION"
    },
    "after": {
      "!doc": "Returns a function that will only be executed after being called N times.",
      "!url": "http://underscorejs.org/#after",
      "!type": "fn(times: number, func: fn()) -> !1"
    },
    "all": "_.every",
    "any": "_.some",
    "bind": {
      "!doc": "Create a function bound to a given object (assigning `this`, and arguments, optionally).",
      "!type": "fn(func: ?, context?: ?, args?: ?) -> !0",
      "!url": "http://underscorejs.org/#bind"
    },
    "bindAll": {
      "!doc": "Bind all of an object's methods to that object.",
      "!type": "fn(obj: ?, names?: [string])",
      "!url": "http://underscorejs.org/#bindAll"
    },
    "chain": {
      "!doc": "Add a \"chain\" function, which will delegate to the wrapper.",
      "!type": "fn(obj: ?)",
      "!url": "http://underscorejs.org/#chain"
    },
    "clone": {
      "!doc": "Create a (shallow-cloned) duplicate of an object.",
      "!type": "fn(obj: ?) -> !0",
      "!url": "http://underscorejs.org/#clone"
    },
    "collect": "_.map",
    "compact": {
      "!doc": "Trim out all falsy values from an array.",
      "!type": "fn(array: [?]) -> [?]",
      "!url": "http://underscorejs.org/#compact"
    },
    "compose": {
      "!doc": "Returns a function that is the composition of a list of functions, each consuming the return value of the function that follows.",
      "!type": "fn(a: fn(), b: fn()) -> fn() -> !1.!ret",
      "!url": "http://underscorejs.org/#compose"
    },
    "contains": {
      "!doc": "Determine if the array or object contains a given value (using `===`).",
      "!type": "fn(list: [?], target: ?) -> bool",
      "!url": "http://underscorejs.org/#contains"
    },
    "countBy": {
      "!doc": "Counts instances of an object that group by a certain criterion.",
      "!type": "fn(obj: ?, iterator: fn(elt: ?, i: number) -> ?, context?: ?) -> ?",
      "!url": "http://underscorejs.org/#countBy"
    },
    "debounce": {
      "!doc": "Returns a function, that, as long as it continues to be invoked, will not be triggered.",
      "!type": "fn(func: fn(), wait: number, immediate?: bool) -> !0",
      "!url": "http://underscorejs.org/#debounce"
    },
    "defaults": {
      "!doc": "Fill in a given object with default properties.",
      "!type": "fn(obj: ?, defaults: ?) -> !0",
      "!effects": ["copy !1 !0"],
      "!url": "http://underscorejs.org/#defaults"
    },
    "defer": {
      "!doc": "Defers a function, scheduling it to run after the current call stack has cleared.",
      "!type": "fn(func: fn(), args?: ?) -> number",
      "!url": "http://underscorejs.org/#defer"
    },
    "delay": {
      "!doc": "Delays a function for the given number of milliseconds, and then calls it with the arguments supplied.",
      "!type": "fn(func: fn(), wait: number, args?: ?) -> number",
      "!url": "http://underscorejs.org/#delay"
    },
    "detect": "_.find",
    "difference": {
      "!doc": "Take the difference between one array and a number of other arrays.",
      "!type": "fn(array: [?], others?: [?]) -> !0",
      "!url": "http://underscorejs.org/#difference"
    },
    "drop": "_.rest",
    "each": {
      "!doc": "Iterates over a list of elements, yielding each in turn to an iterator function.",
      "!type": "fn(obj: [?], iterator: fn(value: ?, index: number), context?: ?)",
      "!effects": ["call !1 this=!2 !0.<i> number"],
      "!url": "http://underscorejs.org/#each"
    },
    "escape": {
      "!doc": "Escapes a string for insertion into HTML.",
      "!type": "fn(string) -> string",
      "!url": "http://underscorejs.org/#escape"
    },
    "every": {
      "!doc": "Determine whether all of the elements match a truth test.",
      "!type": "fn(list: [?], iterator: fn(elt: ?, i: number) -> bool, context?: ?) -> bool",
      "!effects": ["call !1 this=!2 !0.<i> number"],
      "!url": "http://underscorejs.org/#every"
    },
    "extend": {
      "!doc": "Extend a given object with all the properties in passed-in object(s).",
      "!type": "fn(destination: ?, source1: ?, source2?: ?) -> !0",
      "!effects": ["copy !1 !0", "copy !2 !0"],
      "!url": "http://underscorejs.org/#extend"
    },
    "filter": {
      "!doc": "Looks through each value in the list, returning an array of all the values that pass a truth test.",
      "!type": "fn(list: [?], test: fn(value: ?, index: number) -> bool, context?: ?) -> !0",
      "!effects": ["call !1 this=!2 !0.<i> number"],
      "!url": "http://underscorejs.org/#filter"
    },
    "find": {
      "!doc": "Return the first value which passes a truth test.",
      "!type": "fn(list: [?], test: fn(?) -> bool, context?: ?) -> !0.<i>",
      "!effects": ["call !1 !0.<i>"],
      "!url": "http://underscorejs.org/#find"
    },
    "findWhere": {
      "!doc": "Looks through the list and returns the first value that matches all of the key-value pairs listed in properties.",
      "!type": "fn(list: [?], attrs: ?) -> !0.<i>",
      "!url": "http://underscorejs.org/#findWhere"
    },
    "first": {
      "!doc": "Get the first element of an array. Passing n will return the first N values in the array.",
      "!type": "fn(list: [?], n?: number) -> !0.<i>",
      "!url": "http://underscorejs.org/#first"
    },
    "flatten": {
      "!doc": "Return a completely flattened version of an array.",
      "!type": "fn(array: [?], shallow?: bool) -> [?]",
      "!url": "http://underscorejs.org/#flatten"
    },
    "foldl": "_.reduce",
    "foldr": "_.reduceRight",
    "forEach": "_.each",
    "functions": {
      "!doc": "Return a sorted list of the function names available on the object.",
      "!type": "fn(obj: _) -> [string]",
      "!url": "http://underscorejs.org/#functions"
    },
    "groupBy": {
      "!doc": "Groups the object's values by a criterion.",
      "!type": "fn(obj: [?], iterator: fn(elt: ?, i: number) -> ?, context?: ?) -> ?",
      "!url": "http://underscorejs.org/#groupBy"
    },
    "has": {
      "!doc": "Shortcut function for checking if an object has a given property directly on itself (in other words, not on a prototype).",
      "!type": "fn(obj: ?, key: string) -> bool",
      "!url": "http://underscorejs.org/#has"
    },
    "head": "_.first",
    "identity": {
      "!doc": "Returns the same value that is used as the argument.",
      "!type": "fn(value: ?) -> !0",
      "!url": "http://underscorejs.org/#identity"
    },
    "include": "_.contains",
    "indexOf": {
      "!doc": "Returns the index at which value can be found in the array, or -1 if value is not present in the array.",
      "!type": "fn(list: [?], item: ?, isSorted?: bool) -> number",
      "!url": "http://underscorejs.org/#indexOf"
    },
    "initial": {
      "!doc": "Returns everything but the last entry of the array.",
      "!type": "fn(array: [?], n?: number) -> !0",
      "!url": "http://underscorejs.org/#initial"
    },
    "inject": "_.reduce",
    "intersection": {
      "!doc": "Produce an array that contains every item shared between all the passed-in arrays.",
      "!type": "fn(array: [?], others?: [?]) -> !0",
      "!url": "http://underscorejs.org/#intersection"
    },
    "invert": {
      "!doc": "Invert the keys and values of an object.",
      "!type": "fn(obj: ?) -> ?",
      "!url": "http://underscorejs.org/#invert"
    },
    "invoke": {
      "!doc": "Invoke a method (with arguments) on every item in a collection.",
      "!type": "fn(obj: ?, method: string, args?: ?) -> [?]",
      "!url": "http://underscorejs.org/#invoke"
    },
    "isArguments": {
      "!doc": "Returns true if object is an Arguments object.",
      "!type": "fn(obj: ?) -> bool",
      "!url": "http://underscorejs.org/#isArguments"
    },
    "isArray": {
      "!doc": "Is a given value an array? Delegates to ECMA5's native Array.isArray",
      "!type": "fn(obj: ?) -> bool",
      "!url": "http://underscorejs.org/#isArray"
    },
    "isBoolean": {
      "!doc": "Is a given value a boolean?",
      "!type": "fn(obj: ?) -> bool",
      "!url": "http://underscorejs.org/#isBoolean"
    },
    "isDate": {
      "!doc": "Returns true if object is a Date object.",
      "!type": "fn(obj: ?) -> bool",
      "!url": "http://underscorejs.org/#isDate"
    },
    "isElement": {
      "!doc": "Is a given value a DOM element?",
      "!type": "fn(obj: ?) -> bool",
      "!url": "http://underscorejs.org/#isElement"
    },
    "isEmpty": {
      "!doc": "Is a given array, string, or object empty? An \"empty\" object has no enumerable own-properties.",
      "!type": "fn(obj: ?) -> bool",
      "!url": "http://underscorejs.org/#isEmpty"
    },
    "isEqual": {
      "!doc": "Perform a deep comparison to check if two objects are equal.",
      "!type": "fn(a: ?, b: ?) -> bool",
      "!url": "http://underscorejs.org/#isEqual"
    },
    "isFinite": {
      "!doc": "Is a given object a finite number?",
      "!type": "fn(obj: ?) -> bool",
      "!url": "http://underscorejs.org/#isFinite"
    },
    "isFunction": {
      "!doc": "Returns true if object is a Function.",
      "!type": "fn(obj: ?) -> bool",
      "!url": "http://underscorejs.org/#isFunction"
    },
    "isNaN": {
      "!doc": "Is the given value `NaN`? (NaN is the only number which does not equal itself).",
      "!type": "fn(obj: ?) -> bool",
      "!url": "http://underscorejs.org/#isNaN"
    },
    "isNull": {
      "!doc": "Is a given value equal to null?",
      "!type": "fn(obj: ?) -> bool",
      "!url": "http://underscorejs.org/#isNull"
    },
    "isNumber": {
      "!doc": "Returns true if object is a Number (including NaN).",
      "!type": "fn(obj: ?) -> bool",
      "!url": "http://underscorejs.org/#isNumber"
    },
    "isObject": {
      "!doc": "Is a given variable an object?",
      "!type": "fn(obj: ?) -> bool",
      "!url": "http://underscorejs.org/#isObject"
    },
    "isRegExp": {
      "!doc": "Returns true if object is a regular expression.",
      "!type": "fn(obj: ?) -> bool",
      "!url": "http://underscorejs.org/#isRegExp"
    },
    "isString": {
      "!doc": "Returns true if object is a String.",
      "!type": "fn(obj: ?) -> bool",
      "!url": "http://underscorejs.org/#isString"
    },
    "isUndefined": {
      "!doc": "Is a given variable undefined?",
      "!type": "fn(obj: ?) -> bool",
      "!url": "http://underscorejs.org/#isUndefined"
    },
    "keys": {
      "!doc": "Retrieve the names of an object's properties. Delegates to ECMAScript 5's native `Object.keys`",
      "!type": "fn(obj: ?) -> [string]",
      "!url": "http://underscorejs.org/#keys"
    },
    "last": {
      "!doc": "Get the last element of an array.",
      "!type": "fn(array: [?], n?: number) -> !0.<i>",
      "!url": "http://underscorejs.org/#last"
    },
    "lastIndexOf": {
      "!doc": "Returns the index of the last occurrence of value in the array, or -1 if value is not present.",
      "!type": "fn(array: [?], item: ?, from?: number) -> number",
      "!url": "http://underscorejs.org/#lastIndexOf"
    },
    "map": {
      "!doc": "Produces a new array of values by mapping each value in list through a transformation function (iterator).",
      "!type": "fn(obj: [?], iterator: fn(elt: ?, i: number) -> ?, context?: ?) -> [!1.!ret]",
      "!effects": ["call !1 !this=!2 !0.<i> number"],
      "!url": "http://underscorejs.org/#map"
    },
    "max": {
      "!doc": "Returns the maximum value in list.",
      "!type": "fn(list: [?], iterator?: fn(elt: ?, i: number) -> number, context?: ?) -> number",
      "!url": "http://underscorejs.org/#max"
    },
    "memoize": {
      "!doc": "Memoize an expensive function by storing its results.",
      "!type": "fn(func: fn(), hasher?: fn(args: ?) -> ?) -> !0",
      "!url": "http://underscorejs.org/#memoize"
    },
    "methods": "_.functions",
    "min": {
      "!doc": "Returns the minimum value in list.",
      "!type": "fn(list: [?], iterator?: fn(elt: ?, i: number) -> number, context?: ?) -> number",
      "!url": "http://underscorejs.org/#min"
    },
    "mixin": {
      "!doc": "Add your own custom functions to the Underscore object.",
      "!type": "fn(obj: _)",
      "!url": "http://underscorejs.org/#mixin"
    },
    "noConflict": {
      "!doc": "Run Underscore.js in *noConflict* mode, returning the `_` variable to its previous owner. Returns a reference to the Underscore object.",
      "!type": "fn() -> _",
      "!url": "http://underscorejs.org/#noConflict"
    },
    "object": {
      "!doc": "Converts lists into objects.",
      "!type": "fn(list: [?], values?: [?]) -> ?",
      "!url": "http://underscorejs.org/#object"
    },
    "omit": {
      "!doc": "Return a copy of the object without the blacklisted properties.",
      "!type": "fn(obj: ?, keys?: string) -> !0",
      "!url": "http://underscorejs.org/#omit"
    },
    "once": {
      "!doc": "Returns a function that will be executed at most one time, no matter how often you call it.",
      "!type": "fn(func: fn() -> ?) -> !0",
      "!url": "http://underscorejs.org/#once"
    },
    "pairs": {
      "!doc": "Convert an object into a list of `[key, value]` pairs.",
      "!type": "fn(obj: ?) -> [[?]]",
      "!url": "http://underscorejs.org/#pairs"
    },
    "partial": {
      "!doc": "Partially apply a function by creating a version that has had some of its arguments pre-filled, without changing its dynamic `this` context.",
      "!type": "fn(func: ?, args?: ?) -> fn()",
      "!url": "http://underscorejs.org/#partial"
    },
    "pick": {
      "!doc": "Return a copy of the object only containing the whitelisted properties.",
      "!type": "fn(obj: ?, keys?: string) -> !0",
      "!url": "http://underscorejs.org/#pick"
    },
    "pluck": {
      "!doc": "Convenience version of a common use case of `map`: fetching a property.",
      "!type": "fn(obj: [?], key: string) -> [?]",
      "!url": "http://underscorejs.org/#pluck"
    },
    "prototype": {
      "chain": {
        "!doc": "Start chaining a wrapped Underscore object.",
        "!type": "fn() -> !this"
      },
      "value": {
        "!doc": "Extracts the result from a wrapped and chained object.",
        "!type": "fn() -> ?"
      },
      "pop": "fn() -> ?",
      "push": "fn(newelt: ?) -> number",
      "reverse": "fn()",
      "shift": "fn() -> ?",
      "sort": "fn() -> !this",
      "splice": "fn(pos: number, amount: number)",
      "unshift": "fn(elt: ?) -> number",
      "concat": "fn(other: ?) -> !this",
      "join": "fn(separator?: string) -> string",
      "slice": "fn(from: number, to?: number) -> !this"
    },
    "random": {
      "!doc": "Return a random integer between min and max (inclusive).",
      "!type": "fn(min: number, max: number) -> number",
      "!url": "http://underscorejs.org/#random"
    },
    "range": {
      "!doc": "A function to create flexibly-numbered lists of integers.",
      "!type": "fn(start?: number, stop: number, step?: number) -> [number]",
      "!url": "http://underscorejs.org/#range"
    },
    "reduce": {
      "!doc": "reduce boils down a list of values into a single value.",
      "!type": "fn(list: [?], iterator: fn(sum: ?, elt: ?, i: number) -> ?, init?: ?, context?: ?) -> !1.!ret",
      "!effects": ["call !1 this=!3 !2 !0.<i> number"],
      "!url": "http://underscorejs.org/#reduce"
    },
    "reduceRight": {
      "!doc": "The right-associative version of reduce, also known as `foldr`.",
      "!type": "fn(list: [?], iterator: fn(sum: ?, elt: ?, i: number) -> ?, init?: ?, context?: ?) -> !1.!ret",
      "!effects": ["call !1 this=!3 !2 !0.<i> number"],
      "!url": "http://underscorejs.org/#reduceRight"
    },
    "reject": {
      "!doc": "Returns the values in list without the elements that the truth test (iterator) passes. The opposite of filter.",
      "!type": "fn(list: [?], iterator: fn(elt: ?, i: number) -> bool, context?: ?) -> !0",
      "!effects": ["call !1 this=!3 !0.<i> number"],
      "!url": "http://underscorejs.org/#reject"
    },
    "rest": {
      "!doc": "Returns the rest of the elements in an array.",
      "!type": "fn(array: [?], n?: number) -> !0",
      "!url": "http://underscorejs.org/#rest"
    },
    "result": {
      "!doc": "If the value of the named `property` is a function then invoke it with the `object` as context; otherwise, return it.",
      "!type": "fn(object: ?, property: string) -> !0.<i>",
      "!url": "http://underscorejs.org/#result"
    },
    "select": "_.filter",
    "shuffle": {
      "!doc": "Shuffle an array.",
      "!type": "fn(list: [?]) -> !0",
      "!url": "http://underscorejs.org/#shuffle"
    },
    "size": {
      "!doc": "Return the number of elements in an object.",
      "!type": "fn(obj: ?) -> number",
      "!url": "http://underscorejs.org/#size"
    },
    "some": {
      "!doc": "Returns true if any of the values in the list pass the iterator truth test.",
      "!type": "fn(list: [?], iterator: fn(elt: ?, i: number) -> bool, context?: ?) -> bool",
      "!effects": ["call !1 this=!2 !0.<i> number"],
      "!url": "http://underscorejs.org/#some"
    },
    "sortBy": {
      "!doc": "Sort the object's values by a criterion produced by an iterator.",
      "!type": "fn(list: [?], iterator: fn(elt: ?, i: number) -> number, context?: ?) -> !0",
      "!url": "http://underscorejs.org/#sortBy"
    },
    "sortedIndex": {
      "!doc": "Use a comparator function to figure out the smallest index at which an object should be inserted so as to maintain order.",
      "!type": "fn(array: [?], obj: ?, iterator: fn(elt: ?, i: number), context?: ?) -> number",
      "!url": "http://underscorejs.org/#sortedIndex"
    },
    "tail": "_.rest",
    "take": "_.first",
    "tap": {
      "!doc": "Invokes interceptor with the obj, and then returns obj.",
      "!type": "fn(obj: ?, interceptor: fn()) -> !0",
      "!effects": ["call !1 !0"],
      "!url": "http://underscorejs.org/#tap"
    },
    "template": {
      "!doc": "Compiles JavaScript templates into functions that can be evaluated for rendering. ",
      "!type": "fn(text: string, data?: ?, settings?: _.templateSettings) -> fn(data: ?) -> string",
      "!url": "http://underscorejs.org/#template"
    },
    "templateSettings": {
      "!doc": "By default, Underscore uses ERB-style template delimiters, change the following template settings to use alternative delimiters.",
      "escape": "+RegExp",
      "evaluate": "+RegExp",
      "interpolate": "+RegExp",
      "!url": "http://underscorejs.org/#templateSettings"
    },
    "throttle": {
      "!doc": "Returns a function, that, when invoked, will only be triggered at most once during a given window of time.",
      "!type": "fn(func: fn(), wait: number, options?: ?) -> !0",
      "!url": "http://underscorejs.org/#throttle"
    },
    "times": {
      "!doc": "Run a function n times.",
      "!type": "fn(n: number, iterator: fn(), context?: ?) -> [!1.!ret]",
      "!url": "http://underscorejs.org/#times"
    },
    "toArray": {
      "!doc": "Safely create a real, live array from anything iterable.",
      "!type": "fn(obj: ?) -> [?]",
      "!url": "http://underscorejs.org/#toArray"
    },
    "unescape": {
      "!doc": "The opposite of escape.",
      "!type": "fn(string) -> string",
      "!url": "http://underscorejs.org/#unescape"
    },
    "union": {
      "!doc": "Produce an array that contains the union: each distinct element from all of the passed-in arrays.",
      "!type": "fn(array: [?], array2: [?]) -> ?0",
      "!url": "http://underscorejs.org/#union"
    },
    "uniq": {
      "!doc": "Produce a duplicate-free version of the array.",
      "!type": "fn(array: [?], isSorted?: bool, iterator?: fn(elt: ?, i: number), context?: ?) -> [?]",
      "!url": "http://underscorejs.org/#uniq"
    },
    "unique": "_.uniq",
    "uniqueId": {
      "!doc": "Generate a unique integer id (unique within the entire client session). Useful for temporary DOM ids.",
      "!type": "fn(prefix: string) -> string",
      "!url": "http://underscorejs.org/#uniqueId"
    },
    "values": {
      "!doc": "Retrieve the values of an object's properties.",
      "!type": "fn(obj: ?) -> [!0.<i>]",
      "!url": "http://underscorejs.org/#values"
    },
    "where": {
      "!doc": "Looks through each value in the list, returning an array of all the values that contain all of the key-value pairs listed in properties.",
      "!type": "fn(list: [?], attrs: ?) -> !0",
      "!url": "http://underscorejs.org/#where"
    },
    "without": {
      "!doc": "Return a version of the array that does not contain the specified value(s).",
      "!type": "fn(array: [?], values: [?]) -> !0",
      "!url": "http://underscorejs.org/#without"
    },
    "wrap": {
      "!doc": "Returns the first function passed as an argument to the second, allowing you to adjust arguments, run code before and after, and conditionally execute the original function.",
      "!type": "fn(func: fn(), wrapper: fn(?)) -> !0",
      "!effects": ["call !1 !0"],
      "!url": "http://underscorejs.org/#wrap"
    },
    "zip": {
      "!doc": "Zip together multiple lists into a single array -- elements that share an index go together.",
      "!type": "fn(array1: [?], array2: [?]) -> [?]",
      "!url": "http://underscorejs.org/#zip"
    }
  }
}

var tern_webgl = {
    "!name": "webgl",
    "GLbitfield": {"prototype": {"!proto": "Number.prototype"} },
    "GLboolean": {"prototype": {"!proto": "Boolean.prototype"} },
    "GLclampf": {"prototype": {"!proto": "Number.prototype"} },
    "GLenum": {"prototype": {"!proto": "Number.prototype"} },
    "GLfloat": {"prototype": {"!proto": "Number.prototype"} },
    "GLint": {"prototype": {"!proto": "Number.prototype"} },
    "GLintptr": {"prototype": {"!proto": "Number.prototype"} },
    "GLsizei": {"prototype": {"!proto": "Number.prototype"} },
    "GLsizeiptr": {"prototype": {"!proto": "Number.prototype"} },
    "GLuint": {"prototype": {"!proto": "Number.prototype"} },
    "ArrayBufferView": {
        "prototype": {
            "BYTES_PER_ELEMENT": {
                "!type": "number",
            },
            "length": {
                "!type": "number",
            },
            "byteLength": {
                "!type": "number",
            },
            "byteOffset": {
                "!type": "number",
            },
            "set": {
                "!type": "fn(array: [number], offset: number)",
            },
        }
    },

    "Int8Array": { 
        "!type": "fn(arr: [number])",
        "prototype": {
            "!proto": "ArrayBufferView.prototype",
            "subarray": {
                "!type": "fn(begin: number, end: number) -> +Int8Array",
            },
        }
    },
    "Uint8Array": { 
        "!type": "fn(arr: [number])",
        "prototype": {
            "!proto": "ArrayBufferView.prototype",
            "subarray": {
                "!type": "fn(begin: number, end: number) -> +Uint8Array",
            },
        }
    },
    "Int16Array": { 
        "!type": "fn(arr: [number])",
        "prototype": {
            "!proto": "ArrayBufferView.prototype",
            "subarray": {
                "!type": "fn(begin: number, end: number) -> +Int16Array",
            },
        }
    },
    "Uint16Array": { 
        "!type": "fn(arr: [number])",
        "prototype": {
            "!proto": "ArrayBufferView.prototype",
            "subarray": {
                "!type": "fn(begin: number, end: number) -> +Uint16Array",
            },
        }
    },
    "Int32Array": { 
        "!type": "fn(arr: [number])",
        "prototype": {
            "!proto": "ArrayBufferView.prototype",
            "subarray": {
                "!type": "fn(begin: number, end: number) -> +Int32Array",
            },
        }
    },
    "Uint32Array": { 
        "!type": "fn(arr: [number])",
        "prototype": {
            "!proto": "ArrayBufferView.prototype",
            "subarray": {
                "!type": "fn(begin: number, end: number) -> +Uint32Array",
            },
        }
    },
    "Float32Array": { 
        "!type": "fn(arr: [number])",
        "prototype": {
            "!proto": "ArrayBufferView.prototype",
            "subarray": {
                "!type": "fn(begin: number, end: number) -> +Float32Array",
            },
        }
    },
    "Float64Array": { 
        "!type": "fn(arr: [number])",
        "prototype": {
            "!proto": "ArrayBufferView.prototype",
            "subarray": {
                "!type": "fn(begin: number, end: number) -> +Float64Array",
            },
        }
    },

    "WebGLActiveInfo": { "prototype": {} },
    "WebGLBuffer": { "prototype": {} },
    "WebGLContextAttributes": { "prototype": {} },
    "WebGLFramebuffer": { "prototype": {} },
    "WebGLProgram": { "prototype": {} },
    "WebGLRenderbuffer": { "prototype": {} },
    "WebGLShader": { "prototype": {} },
    "WebGLShaderPrecisionFormat": { "prototype": {} },
    "WebGLTexture": { "prototype": {} },
    "WebGLUniformLocation": { "prototype": {} },
    "WebGLRenderingContext": {
        "prototype": {
            "DEPTH_BUFFER_BIT": { "!type": "+GLenum" },
            "STENCIL_BUFFER_BIT": { "!type": "+GLenum" },
            "COLOR_BUFFER_BIT": { "!type": "+GLenum" },
            "POINTS": { "!type": "+GLenum" },
            "LINES": { "!type": "+GLenum" },
            "LINE_LOOP": { "!type": "+GLenum" },
            "LINE_STRIP": { "!type": "+GLenum" },
            "TRIANGLES": { "!type": "+GLenum" },
            "TRIANGLE_STRIP": { "!type": "+GLenum" },
            "TRIANGLE_FAN": { "!type": "+GLenum" },
            "ZERO": { "!type": "+GLenum" },
            "ONE": { "!type": "+GLenum" },
            "SRC_COLOR": { "!type": "+GLenum" },
            "ONE_MINUS_SRC_COLOR": { "!type": "+GLenum" },
            "SRC_ALPHA": { "!type": "+GLenum" },
            "ONE_MINUS_SRC_ALPHA": { "!type": "+GLenum" },
            "DST_ALPHA": { "!type": "+GLenum" },
            "ONE_MINUS_DST_ALPHA": { "!type": "+GLenum" },
            "DST_COLOR": { "!type": "+GLenum" },
            "ONE_MINUS_DST_COLOR": { "!type": "+GLenum" },
            "SRC_ALPHA_SATURATE": { "!type": "+GLenum" },
            "FUNC_ADD": { "!type": "+GLenum" },
            "BLEND_EQUATION": { "!type": "+GLenum" },
            "BLEND_EQUATION_RGB": { "!type": "+GLenum" },
            "BLEND_EQUATION_ALPHA": { "!type": "+GLenum" },
            "FUNC_SUBTRACT": { "!type": "+GLenum" },
            "FUNC_REVERSE_SUBTRACT": { "!type": "+GLenum" },
            "BLEND_DST_RGB": { "!type": "+GLenum" },
            "BLEND_SRC_RGB": { "!type": "+GLenum" },
            "BLEND_DST_ALPHA": { "!type": "+GLenum" },
            "BLEND_SRC_ALPHA": { "!type": "+GLenum" },
            "CONSTANT_COLOR": { "!type": "+GLenum" },
            "ONE_MINUS_CONSTANT_COLOR": { "!type": "+GLenum" },
            "CONSTANT_ALPHA": { "!type": "+GLenum" },
            "ONE_MINUS_CONSTANT_ALPHA": { "!type": "+GLenum" },
            "BLEND_COLOR": { "!type": "+GLenum" },
            "ARRAY_BUFFER": { "!type": "+GLenum" },
            "ELEMENT_ARRAY_BUFFER": { "!type": "+GLenum" },
            "ARRAY_BUFFER_BINDING": { "!type": "+GLenum" },
            "ELEMENT_ARRAY_BUFFER_BINDING": { "!type": "+GLenum" },
            "STREAM_DRAW": { "!type": "+GLenum" },
            "STATIC_DRAW": { "!type": "+GLenum" },
            "DYNAMIC_DRAW": { "!type": "+GLenum" },
            "BUFFER_SIZE": { "!type": "+GLenum" },
            "BUFFER_USAGE": { "!type": "+GLenum" },
            "CURRENT_VERTEX_ATTRIB": { "!type": "+GLenum" },
            "FRONT": { "!type": "+GLenum" },
            "BACK": { "!type": "+GLenum" },
            "FRONT_AND_BACK": { "!type": "+GLenum" },
            "CULL_FACE": { "!type": "+GLenum" },
            "BLEND": { "!type": "+GLenum" },
            "DITHER": { "!type": "+GLenum" },
            "STENCIL_TEST": { "!type": "+GLenum" },
            "DEPTH_TEST": { "!type": "+GLenum" },
            "SCISSOR_TEST": { "!type": "+GLenum" },
            "POLYGON_OFFSET_FILL": { "!type": "+GLenum" },
            "SAMPLE_ALPHA_TO_COVERAGE": { "!type": "+GLenum" },
            "SAMPLE_COVERAGE": { "!type": "+GLenum" },
            "NO_ERROR": { "!type": "+GLenum" },
            "INVALID_ENUM": { "!type": "+GLenum" },
            "INVALID_VALUE": { "!type": "+GLenum" },
            "INVALID_OPERATION": { "!type": "+GLenum" },
            "OUT_OF_MEMORY": { "!type": "+GLenum" },
            "CW": { "!type": "+GLenum" },
            "CCW": { "!type": "+GLenum" },
            "LINE_WIDTH": { "!type": "+GLenum" },
            "ALIASED_POINT_SIZE_RANGE": { "!type": "+GLenum" },
            "ALIASED_LINE_WIDTH_RANGE": { "!type": "+GLenum" },
            "CULL_FACE_MODE": { "!type": "+GLenum" },
            "FRONT_FACE": { "!type": "+GLenum" },
            "DEPTH_RANGE": { "!type": "+GLenum" },
            "DEPTH_WRITEMASK": { "!type": "+GLenum" },
            "DEPTH_CLEAR_VALUE": { "!type": "+GLenum" },
            "DEPTH_FUNC": { "!type": "+GLenum" },
            "STENCIL_CLEAR_VALUE": { "!type": "+GLenum" },
            "STENCIL_FUNC": { "!type": "+GLenum" },
            "STENCIL_FAIL": { "!type": "+GLenum" },
            "STENCIL_PASS_DEPTH_FAIL": { "!type": "+GLenum" },
            "STENCIL_PASS_DEPTH_PASS": { "!type": "+GLenum" },
            "STENCIL_REF": { "!type": "+GLenum" },
            "STENCIL_VALUE_MASK": { "!type": "+GLenum" },
            "STENCIL_WRITEMASK": { "!type": "+GLenum" },
            "STENCIL_BACK_FUNC": { "!type": "+GLenum" },
            "STENCIL_BACK_FAIL": { "!type": "+GLenum" },
            "STENCIL_BACK_PASS_DEPTH_FAIL": { "!type": "+GLenum" },
            "STENCIL_BACK_PASS_DEPTH_PASS": { "!type": "+GLenum" },
            "STENCIL_BACK_REF": { "!type": "+GLenum" },
            "STENCIL_BACK_VALUE_MASK": { "!type": "+GLenum" },
            "STENCIL_BACK_WRITEMASK": { "!type": "+GLenum" },
            "VIEWPORT": { "!type": "+GLenum" },
            "SCISSOR_BOX": { "!type": "+GLenum" },
            "COLOR_CLEAR_VALUE": { "!type": "+GLenum" },
            "COLOR_WRITEMASK": { "!type": "+GLenum" },
            "UNPACK_ALIGNMENT": { "!type": "+GLenum" },
            "PACK_ALIGNMENT": { "!type": "+GLenum" },
            "MAX_TEXTURE_SIZE": { "!type": "+GLenum" },
            "MAX_VIEWPORT_DIMS": { "!type": "+GLenum" },
            "SUBPIXEL_BITS": { "!type": "+GLenum" },
            "RED_BITS": { "!type": "+GLenum" },
            "GREEN_BITS": { "!type": "+GLenum" },
            "BLUE_BITS": { "!type": "+GLenum" },
            "ALPHA_BITS": { "!type": "+GLenum" },
            "DEPTH_BITS": { "!type": "+GLenum" },
            "STENCIL_BITS": { "!type": "+GLenum" },
            "POLYGON_OFFSET_UNITS": { "!type": "+GLenum" },
            "POLYGON_OFFSET_FACTOR": { "!type": "+GLenum" },
            "TEXTURE_BINDING_2D": { "!type": "+GLenum" },
            "SAMPLE_BUFFERS": { "!type": "+GLenum" },
            "SAMPLES": { "!type": "+GLenum" },
            "SAMPLE_COVERAGE_VALUE": { "!type": "+GLenum" },
            "SAMPLE_COVERAGE_INVERT": { "!type": "+GLenum" },
            "COMPRESSED_TEXTURE_FORMATS": { "!type": "+GLenum" },
            "DONT_CARE": { "!type": "+GLenum" },
            "FASTEST": { "!type": "+GLenum" },
            "NICEST": { "!type": "+GLenum" },
            "GENERATE_MIPMAP_HINT": { "!type": "+GLenum" },
            "BYTE": { "!type": "+GLenum" },
            "UNSIGNED_BYTE": { "!type": "+GLenum" },
            "SHORT": { "!type": "+GLenum" },
            "UNSIGNED_SHORT": { "!type": "+GLenum" },
            "INT": { "!type": "+GLenum" },
            "UNSIGNED_INT": { "!type": "+GLenum" },
            "FLOAT": { "!type": "+GLenum" },
            "DEPTH_COMPONENT": { "!type": "+GLenum" },
            "ALPHA": { "!type": "+GLenum" },
            "RGB": { "!type": "+GLenum" },
            "RGBA": { "!type": "+GLenum" },
            "LUMINANCE": { "!type": "+GLenum" },
            "LUMINANCE_ALPHA": { "!type": "+GLenum" },
            "UNSIGNED_SHORT_4_4_4_4": { "!type": "+GLenum" },
            "UNSIGNED_SHORT_5_5_5_1": { "!type": "+GLenum" },
            "UNSIGNED_SHORT_5_6_5": { "!type": "+GLenum" },
            "FRAGMENT_SHADER": { "!type": "+GLenum" },
            "VERTEX_SHADER": { "!type": "+GLenum" },
            "MAX_VERTEX_ATTRIBS": { "!type": "+GLenum" },
            "MAX_VERTEX_UNIFORM_VECTORS": { "!type": "+GLenum" },
            "MAX_VARYING_VECTORS": { "!type": "+GLenum" },
            "MAX_COMBINED_TEXTURE_IMAGE_UNITS": { "!type": "+GLenum" },
            "MAX_VERTEX_TEXTURE_IMAGE_UNITS": { "!type": "+GLenum" },
            "MAX_TEXTURE_IMAGE_UNITS": { "!type": "+GLenum" },
            "MAX_FRAGMENT_UNIFORM_VECTORS": { "!type": "+GLenum" },
            "SHADER_TYPE": { "!type": "+GLenum" },
            "DELETE_STATUS": { "!type": "+GLenum" },
            "LINK_STATUS": { "!type": "+GLenum" },
            "VALIDATE_STATUS": { "!type": "+GLenum" },
            "ATTACHED_SHADERS": { "!type": "+GLenum" },
            "ACTIVE_UNIFORMS": { "!type": "+GLenum" },
            "ACTIVE_ATTRIBUTES": { "!type": "+GLenum" },
            "SHADING_LANGUAGE_VERSION": { "!type": "+GLenum" },
            "CURRENT_PROGRAM": { "!type": "+GLenum" },
            "NEVER": { "!type": "+GLenum" },
            "LESS": { "!type": "+GLenum" },
            "EQUAL": { "!type": "+GLenum" },
            "LEQUAL": { "!type": "+GLenum" },
            "GREATER": { "!type": "+GLenum" },
            "NOTEQUAL": { "!type": "+GLenum" },
            "GEQUAL": { "!type": "+GLenum" },
            "ALWAYS": { "!type": "+GLenum" },
            "KEEP": { "!type": "+GLenum" },
            "REPLACE": { "!type": "+GLenum" },
            "INCR": { "!type": "+GLenum" },
            "DECR": { "!type": "+GLenum" },
            "INVERT": { "!type": "+GLenum" },
            "INCR_WRAP": { "!type": "+GLenum" },
            "DECR_WRAP": { "!type": "+GLenum" },
            "VENDOR": { "!type": "+GLenum" },
            "RENDERER": { "!type": "+GLenum" },
            "VERSION": { "!type": "+GLenum" },
            "NEAREST": { "!type": "+GLenum" },
            "LINEAR": { "!type": "+GLenum" },
            "NEAREST_MIPMAP_NEAREST": { "!type": "+GLenum" },
            "LINEAR_MIPMAP_NEAREST": { "!type": "+GLenum" },
            "NEAREST_MIPMAP_LINEAR": { "!type": "+GLenum" },
            "LINEAR_MIPMAP_LINEAR": { "!type": "+GLenum" },
            "TEXTURE_MAG_FILTER": { "!type": "+GLenum" },
            "TEXTURE_MIN_FILTER": { "!type": "+GLenum" },
            "TEXTURE_WRAP_S": { "!type": "+GLenum" },
            "TEXTURE_WRAP_T": { "!type": "+GLenum" },
            "TEXTURE_2D": { "!type": "+GLenum" },
            "TEXTURE": { "!type": "+GLenum" },
            "TEXTURE_CUBE_MAP": { "!type": "+GLenum" },
            "TEXTURE_BINDING_CUBE_MAP": { "!type": "+GLenum" },
            "TEXTURE_CUBE_MAP_POSITIVE_X": { "!type": "+GLenum" },
            "TEXTURE_CUBE_MAP_NEGATIVE_X": { "!type": "+GLenum" },
            "TEXTURE_CUBE_MAP_POSITIVE_Y": { "!type": "+GLenum" },
            "TEXTURE_CUBE_MAP_NEGATIVE_Y": { "!type": "+GLenum" },
            "TEXTURE_CUBE_MAP_POSITIVE_Z": { "!type": "+GLenum" },
            "TEXTURE_CUBE_MAP_NEGATIVE_Z": { "!type": "+GLenum" },
            "MAX_CUBE_MAP_TEXTURE_SIZE": { "!type": "+GLenum" },
            "TEXTURE0": { "!type": "+GLenum" },
            "TEXTURE1": { "!type": "+GLenum" },
            "TEXTURE2": { "!type": "+GLenum" },
            "TEXTURE3": { "!type": "+GLenum" },
            "TEXTURE4": { "!type": "+GLenum" },
            "TEXTURE5": { "!type": "+GLenum" },
            "TEXTURE6": { "!type": "+GLenum" },
            "TEXTURE7": { "!type": "+GLenum" },
            "TEXTURE8": { "!type": "+GLenum" },
            "TEXTURE9": { "!type": "+GLenum" },
            "TEXTURE10": { "!type": "+GLenum" },
            "TEXTURE11": { "!type": "+GLenum" },
            "TEXTURE12": { "!type": "+GLenum" },
            "TEXTURE13": { "!type": "+GLenum" },
            "TEXTURE14": { "!type": "+GLenum" },
            "TEXTURE15": { "!type": "+GLenum" },
            "TEXTURE16": { "!type": "+GLenum" },
            "TEXTURE17": { "!type": "+GLenum" },
            "TEXTURE18": { "!type": "+GLenum" },
            "TEXTURE19": { "!type": "+GLenum" },
            "TEXTURE20": { "!type": "+GLenum" },
            "TEXTURE21": { "!type": "+GLenum" },
            "TEXTURE22": { "!type": "+GLenum" },
            "TEXTURE23": { "!type": "+GLenum" },
            "TEXTURE24": { "!type": "+GLenum" },
            "TEXTURE25": { "!type": "+GLenum" },
            "TEXTURE26": { "!type": "+GLenum" },
            "TEXTURE27": { "!type": "+GLenum" },
            "TEXTURE28": { "!type": "+GLenum" },
            "TEXTURE29": { "!type": "+GLenum" },
            "TEXTURE30": { "!type": "+GLenum" },
            "TEXTURE31": { "!type": "+GLenum" },
            "ACTIVE_TEXTURE": { "!type": "+GLenum" },
            "REPEAT": { "!type": "+GLenum" },
            "CLAMP_TO_EDGE": { "!type": "+GLenum" },
            "MIRRORED_REPEAT": { "!type": "+GLenum" },
            "FLOAT_VEC2": { "!type": "+GLenum" },
            "FLOAT_VEC3": { "!type": "+GLenum" },
            "FLOAT_VEC4": { "!type": "+GLenum" },
            "INT_VEC2": { "!type": "+GLenum" },
            "INT_VEC3": { "!type": "+GLenum" },
            "INT_VEC4": { "!type": "+GLenum" },
            "BOOL": { "!type": "+GLenum" },
            "BOOL_VEC2": { "!type": "+GLenum" },
            "BOOL_VEC3": { "!type": "+GLenum" },
            "BOOL_VEC4": { "!type": "+GLenum" },
            "FLOAT_MAT2": { "!type": "+GLenum" },
            "FLOAT_MAT3": { "!type": "+GLenum" },
            "FLOAT_MAT4": { "!type": "+GLenum" },
            "SAMPLER_2D": { "!type": "+GLenum" },
            "SAMPLER_CUBE": { "!type": "+GLenum" },
            "VERTEX_ATTRIB_ARRAY_ENABLED": { "!type": "+GLenum" },
            "VERTEX_ATTRIB_ARRAY_SIZE": { "!type": "+GLenum" },
            "VERTEX_ATTRIB_ARRAY_STRIDE": { "!type": "+GLenum" },
            "VERTEX_ATTRIB_ARRAY_TYPE": { "!type": "+GLenum" },
            "VERTEX_ATTRIB_ARRAY_NORMALIZED": { "!type": "+GLenum" },
            "VERTEX_ATTRIB_ARRAY_POINTER": { "!type": "+GLenum" },
            "VERTEX_ATTRIB_ARRAY_BUFFER_BINDING": { "!type": "+GLenum" },
            "IMPLEMENTATION_COLOR_READ_TYPE": { "!type": "+GLenum" },
            "IMPLEMENTATION_COLOR_READ_FORMAT": { "!type": "+GLenum" },
            "COMPILE_STATUS": { "!type": "+GLenum" },
            "LOW_FLOAT": { "!type": "+GLenum" },
            "MEDIUM_FLOAT": { "!type": "+GLenum" },
            "HIGH_FLOAT": { "!type": "+GLenum" },
            "LOW_INT": { "!type": "+GLenum" },
            "MEDIUM_INT": { "!type": "+GLenum" },
            "HIGH_INT": { "!type": "+GLenum" },
            "FRAMEBUFFER": { "!type": "+GLenum" },
            "RENDERBUFFER": { "!type": "+GLenum" },
            "RGBA4": { "!type": "+GLenum" },
            "RGB5_A1": { "!type": "+GLenum" },
            "RGB565": { "!type": "+GLenum" },
            "DEPTH_COMPONENT16": { "!type": "+GLenum" },
            "STENCIL_INDEX": { "!type": "+GLenum" },
            "STENCIL_INDEX8": { "!type": "+GLenum" },
            "DEPTH_STENCIL": { "!type": "+GLenum" },
            "RENDERBUFFER_WIDTH": { "!type": "+GLenum" },
            "RENDERBUFFER_HEIGHT": { "!type": "+GLenum" },
            "RENDERBUFFER_INTERNAL_FORMAT": { "!type": "+GLenum" },
            "RENDERBUFFER_RED_SIZE": { "!type": "+GLenum" },
            "RENDERBUFFER_GREEN_SIZE": { "!type": "+GLenum" },
            "RENDERBUFFER_BLUE_SIZE": { "!type": "+GLenum" },
            "RENDERBUFFER_ALPHA_SIZE": { "!type": "+GLenum" },
            "RENDERBUFFER_DEPTH_SIZE": { "!type": "+GLenum" },
            "RENDERBUFFER_STENCIL_SIZE": { "!type": "+GLenum" },
            "FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE": { "!type": "+GLenum" },
            "FRAMEBUFFER_ATTACHMENT_OBJECT_NAME": { "!type": "+GLenum" },
            "FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL": { "!type": "+GLenum" },
            "FRAMEBUFFER_ATTACHMENT_TEXTURE_CUBE_MAP_FACE": { "!type": "+GLenum" },
            "COLOR_ATTACHMENT0": { "!type": "+GLenum" },
            "DEPTH_ATTACHMENT": { "!type": "+GLenum" },
            "STENCIL_ATTACHMENT": { "!type": "+GLenum" },
            "DEPTH_STENCIL_ATTACHMENT": { "!type": "+GLenum" },
            "NONE": { "!type": "+GLenum" },
            "FRAMEBUFFER_COMPLETE": { "!type": "+GLenum" },
            "FRAMEBUFFER_INCOMPLETE_ATTACHMENT": { "!type": "+GLenum" },
            "FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT": { "!type": "+GLenum" },
            "FRAMEBUFFER_INCOMPLETE_DIMENSIONS": { "!type": "+GLenum" },
            "FRAMEBUFFER_UNSUPPORTED": { "!type": "+GLenum" },
            "FRAMEBUFFER_BINDING": { "!type": "+GLenum" },
            "RENDERBUFFER_BINDING": { "!type": "+GLenum" },
            "MAX_RENDERBUFFER_SIZE": { "!type": "+GLenum" },
            "INVALID_FRAMEBUFFER_OPERATION": { "!type": "+GLenum" },
            "UNPACK_FLIP_Y_WEBGL": { "!type": "+GLenum" },
            "UNPACK_PREMULTIPLY_ALPHA_WEBGL": { "!type": "+GLenum" },
            "CONTEXT_LOST_WEBGL": { "!type": "+GLenum" },
            "UNPACK_COLORSPACE_CONVERSION_WEBGL": { "!type": "+GLenum" },
            "BROWSER_DEFAULT_WEBGL": { "!type": "+GLenum" },
            "getContextAttributes": {
                "!type": "fn() -> +WebGLContextAttributes"
            },
            "isContextLost": {
                "!type": "fn() -> bool"
            },
            "getSupportedExtensions": {
                "!type": "fn() -> [string]"
            },
            "getExtension": {
                "!type": "fn(name: string) -> object"
            },
            "activeTexture": {
                "!type": "fn(texture: +GLenum)"
            },
            "attachShader": {
                "!type": "fn(program: +WebGLProgram, shader: +WebGLShader)"
            },
            "bindAttribLocation": {
                "!type": "fn(program: +WebGLProgram, index: +GLuint, name: string)"
            },
            "bindBuffer": {
                "!type": "fn(target: +GLenum, buffer: +WebGLBuffer)"
            },
            "bindFramebuffer": {
                "!type": "fn(target: +GLenum, framebuffer: +WebGLFramebuffer)"
            },
            "bindRenderbuffer": {
                "!type": "fn(target: +GLenum, renderbuffer: +WebGLRenderbuffer)"
            },
            "bindTexture": {
                "!type": "fn(target: +GLenum, texture: +WebGLTexture)"
            },
            "blendColor": {
                "!type": "fn(red: +GLclampf, green: +GLclampf, blue: +GLclampf, alpha: +GLclampf)"
            },
            "blendEquation": {
                "!type": "fn(mode: +GLenum)"
            },
            "blendEquationSeparate": {
                "!type": "fn(modeRGB: +GLenum, modeAlpha: +GLenum)"
            },
            "blendFunc": {
                "!type": "fn(sfactor: +GLenum, dfactor: +GLenum)"
            },
            "blendFuncSeparate": {
                "!type": "fn(srcRGB: +GLenum, dstRGB: +GLenum, srcAlpha: +GLenum, dstAlpha: +GLenum)"
            },
            "bufferData": {
                "!type": "fn(target: +GLenum, data: +ArrayBufferView, usage: +GLenum)"
            },
            "bufferSubData": {
                "!type": "fn(target: +GLenum, offset: +GLintptr, data: +ArrayBufferView)"
            },
            "checkFramebufferStatus": {
                "!type": "fn(target: +GLenum) -> +GLenum"
            },
            "clear": {
                "!type": "fn(mask: +GLbitfield)"
            },
            "clearColor": {
                "!type": "fn(red: +GLclampf, green: +GLclampf, blue: +GLclampf, alpha: +GLclampf)"
            },
            "clearDepth": {
                "!type": "fn(depth: +GLclampf)"
            },
            "clearStencil": {
                "!type": "fn(s: +GLint)"
            },
            "colorMask": {
                "!type": "fn(red: +GLboolean, green: +GLbool, blue: +GLbool, alpha: +GLbool)"
            },
            "compileShader": {
                "!type": "fn(shader: +WebGLShader)"
            },
            "compressedTexImage2D": {
                "!type": "fn(target: +GLenum, level: +GLint, internalformat: +GLenum, width: +GLsizei, height: +GLsizei, border: +GLint, data: +ArrayBufferView)"
            },
            "compressedTexSubImage2D": {
                "!type": "fn(target: +GLenum, level: +GLint, xoffset: +GLint, yoffset: +GLint, width: +GLsizei, height: +GLsizei, format: +GLenum, data: +ArrayBufferView)"
            },
            "copyTexImage2D": {
                "!type": "fn(target: +GLenum, level: +GLint, internalformat: +GLenum, x: +GLint, y: +GLint, width: +GLsizei, height: +GLsizei, border: +GLint)"
            },
            "copyTexSubImage2D": {
                "!type": "fn(target: +GLenum, level: +GLint, xoffset: +GLint, yoffset: +GLint, x: +GLint, y: +GLint, width: +GLsizei, height: +GLsizei)"
            },
            "createBuffer": {
                "!type": "fn() -> +WebGLBuffer"
            },
            "createFramebuffer": {
                "!type": "fn() -> +WebGLFramebuffer"
            },
            "createProgram": {
                "!type": "fn() -> +WebGLProgram"
            },
            "createRenderbuffer": {
                "!type": "fn() -> +WebGLRenderbuffer"
            },
            "createShader": {
                "!type": "fn(type: +GLenum) -> +WebGLShader"
            },
            "createTexture": {
                "!type": "fn() -> +WebGLTexture"
            },
            "cullFace": {
                "!type": "fn(mode: +GLenum)"
            },
            "deleteBuffer": {
                "!type": "fn(buffer: +WebGLBuffer)"
            },
            "deleteFramebuffer": {
                "!type": "fn(framebuffer: +WebGLFramebuffer)"
            },
            "deleteProgram": {
                "!type": "fn(program: +WebGLProgram)"
            },
            "deleteRenderbuffer": {
                "!type": "fn(renderbuffer: +WebGLRenderbuffer)"
            },
            "deleteShader": {
                "!type": "fn(shader: +WebGLShader)"
            },
            "deleteTexture": {
                "!type": "fn(texture: +WebGLTexture)"
            },
            "depthFunc": {
                "!type": "fn(func: +GLenum)"
            },
            "depthMask": {
                "!type": "fn(flag: +GLboolean)"
            },
            "depthRange": {
                "!type": "fn(zNear: +GLclampf, zFar: +GLclampf)"
            },
            "detachShader": {
                "!type": "fn(program: +WebGLProgram, shader: +WebGLShader)"
            },
            "disable": {
                "!type": "fn(cap: +GLenum)"
            },
            "disableVertexAttribArray": {
                "!type": "fn(index: +GLuint)"
            },
            "drawArrays": {
                "!type": "fn(mode: +GLenum, first: +GLint, count: +GLsizei)"
            },
            "drawElements": {
                "!type": "fn(mode: +GLenum, count: +GLsizei, type: +GLenum, offset: +GLintptr)"
            },
            "enable": {
                "!type": "fn(cap: +GLenum)"
            },
            "enableVertexAttribArray": {
                "!type": "fn(index: +GLuint)"
            },
            "finish": {
                "!type": "fn()"
            },
            "flush": {
                "!type": "fn()"
            },
            "framebufferRenderbuffer": {
                "!type": "fn(target: +GLenum, attachment: +GLenum, renderbuffertarget: +GLenum, renderbuffer: +WebGLRenderbuffer)"
            },
            "framebufferTexture2D": {
                "!type": "fn(target: +GLenum, attachment: +GLenum, textarget: +GLenum, texture: +WebGLTexture, level: +GLint)"
            },
            "frontFace": {
                "!type": "fn(mode: +GLenum)"
            },
            "generateMipmap": {
                "!type": "fn(target: +GLenum)"
            },
            "getActiveAttrib": {
                "!type": "fn(program: +WebGLProgram, index: +GLuint) -> +WebGLActiveInfo"
            },
            "getActiveUniform": {
                "!type": "fn(program: +WebGLProgram, index: +GLuint) -> +WebGLActiveInfo"
            },
            "getAttachedShaders": {
                "!type": "fn(program: +WebGLProgram) -> [+WebGLShader]"
            },
            "getAttribLocation": {
                "!type": "fn(program: +WebGLProgram, name: string) -> +GLint"
            },
            "getBufferParameter": {
                "!type": "fn(target: +GLenum, pname: +GLenum) -> ?"
            },
            "getParameter": {
                "!type": "fn(pname: +GLenum) -> ?"
            },
            "getError": {
                "!type": "fn() -> +GLenum"
            },
            "getFramebufferAttachmentParameter": {
                "!type": "fn(target: +GLenum, attachment: +GLenum, pname: +GLenum) -> ?"
            },
            "getProgramParameter": {
                "!type": "fn(program: +WebGLProgram, pname: +GLenum) -> ?"
            },
            "getProgramInfoLog": {
                "!type": "fn(program: +WebGLProgram) -> string"
            },
            "getRenderbufferParameter": {
                "!type": "fn(target: +GLenum, pname: +GLenum) -> ?"
            },
            "getShaderParameter": {
                "!type": "fn(shader: +WebGLShader, pname: +GLenum) -> ?"
            },
            "getShaderPrecisionFormat": {
                "!type": "fn(shadertype: +GLenum, precisiontype: +GLenum) -> +WebGLShaderPrecisionFormat"
            },
            "getShaderInfoLog": {
                "!type": "fn(shader: +WebGLShader) -> string"
            },
            "getShaderSource": {
                "!type": "fn(shader: +WebGLShader) -> string"
            },
            "getTexParameter": {
                "!type": "fn(target: +GLenum, pname: +GLenum) -> ?"
            },
            "getUniform": {
                "!type": "fn(program: +WebGLProgram, location: +WebGLUniformLocation) -> ?"
            },
            "getUniformLocation": {
                "!type": "fn(program: +WebGLProgram, name: string) -> +WebGLUniformLocation"
            },
            "getVertexAttrib": {
                "!type": "fn(index: +GLuint, pname: +GLenum) -> ?"
            },
            "getVertexAttribOffset": {
                "!type": "fn(index: +GLuint, pname: +GLenum) -> +GLsizeiptr"
            },
            "hint": {
                "!type": "fn(target: +GLenum, mode: +GLenum)"
            },
            "isBuffer": {
                "!type": "fn(buffer: +WebGLBuffer) -> +GLboolean"
            },
            "isEnabled": {
                "!type": "fn(cap: +GLenum) -> +GLboolean"
            },
            "isFramebuffer": {
                "!type": "fn(framebuffer: +WebGLFramebuffer) -> +GLboolean"
            },
            "isProgram": {
                "!type": "fn(program: +WebGLProgram) -> +GLboolean"
            },
            "isRenderbuffer": {
                "!type": "fn(renderbuffer: +WebGLRenderbuffer) -> +GLboolean"
            },
            "isShader": {
                "!type": "fn(shader: +WebGLShader) -> +GLboolean"
            },
            "isTexture": {
                "!type": "fn(texture: +WebGLTexture) -> +GLboolean"
            },
            "lineWidth": {
                "!type": "fn(width: +GLfloat)"
            },
            "linkProgram": {
                "!type": "fn(program: +WebGLProgram)"
            },
            "pixelStorei": {
                "!type": "fn(pname: +GLenum, param: +GLint)"
            },
            "polygonOffset": {
                "!type": "fn(factor: +GLfloat, units: +GLfloat)"
            },
            "readPixels": {
                "!type": "fn(x: +GLint, y: +GLint, width: +GLsizei, height: +GLsizei, format: +GLenum, type: +GLenum, pixels: +ArrayBufferView)"
            },
            "renderbufferStorage": {
                "!type": "fn(target: +GLenum, internalformat: +GLenum, width: +GLsizei, height: +GLsizei)"
            },
            "sampleCoverage": {
                "!type": "fn(value: +GLclampf, invert: +GLboolean)"
            },
            "scissor": {
                "!type": "fn(x: +GLint, y: +GLint, width: +GLsizei, height: +GLsizei)"
            },
            "shaderSource": {
                "!type": "fn(shader: +WebGLShader, source: string)"
            },
            "stencilFunc": {
                "!type": "fn(func: +GLenum, ref: +GLint, mask: +GLuint)"
            },
            "stencilFuncSeparate": {
                "!type": "fn(face: +GLenum, func: +GLenum, ref: +GLint, mask: +GLuint)"
            },
            "stencilMask": {
                "!type": "fn(mask: +GLuint)"
            },
            "stencilMaskSeparate": {
                "!type": "fn(face: +GLenum, mask: +GLuint)"
            },
            "stencilOp": {
                "!type": "fn(fail: +GLenum, zfail: +GLenum, zpass: +GLenum)"
            },
            "stencilOpSeparate": {
                "!type": "fn(face: +GLenum, fail: +GLenum, zfail: +GLenum, zpass: +GLenum)"
            },
            "texImage2D": {
                "!type": "fn(target: +GLenum, level: +GLint, internalformat: +GLenum, format: +GLenum, type: +GLenum, ?)"
            },
            "texParameterf": {
                "!type": "fn(target: +GLenum, pname: +GLenum, param: +GLfloat)"
            },
            "texParameteri": {
                "!type": "fn(target: +GLenum, pname: +GLenum, param: +GLint)"
            },
            "texSubImage2D": {
                "!type": "fn(target: +GLenum, level: +GLint, xoffset: +GLint, yoffset: +GLint, format: +GLenum, type: +GLenum, ?)"
            },
            "uniform1f": {
                "!type": "fn(location: +WebGLUniformLocation, x: +GLfloat)"
            },
            "uniform1fv": {
                "!type": "fn(location: +WebGLUniformLocation, v: [+GLfloat])"
            },
            "uniform1i": {
                "!type": "fn(location: +WebGLUniformLocation, x: +GLint)"
            },
            "uniform1iv": {
                "!type": "fn(location: +WebGLUniformLocation, v: [long])"
            },
            "uniform2f": {
                "!type": "fn(location: +WebGLUniformLocation, x: +GLfloat, y: +GLfloat)"
            },
            "uniform2fv": {
                "!type": "fn(location: +WebGLUniformLocation, v: [+GLfloat])"
            },
            "uniform2i": {
                "!type": "fn(location: +WebGLUniformLocation, x: +GLint, y: +GLint)"
            },
            "uniform2iv": {
                "!type": "fn(location: +WebGLUniformLocation, v: [long])"
            },
            "uniform3f": {
                "!type": "fn(location: +WebGLUniformLocation, x: +GLfloat, y: +GLfloat, z: +GLfloat)"
            },
            "uniform3fv": {
                "!type": "fn(location: +WebGLUniformLocation, v: [+GLfloat])"
            },
            "uniform3i": {
                "!type": "fn(location: +WebGLUniformLocation, x: +GLint, y: +GLint, z: +GLint)"
            },
            "uniform3iv": {
                "!type": "fn(location: +WebGLUniformLocation, v: [long])"
            },
            "uniform4f": {
                "!type": "fn(location: +WebGLUniformLocation, x: +GLfloat, y: +GLfloat, z: +GLfloat, w: +GLfloat)"
            },
            "uniform4fv": {
                "!type": "fn(location: +WebGLUniformLocation, v: [+GLfloat])"
            },
            "uniform4i": {
                "!type": "fn(location: +WebGLUniformLocation, x: +GLint, y: +GLint, z: +GLint, w: +GLint)"
            },
            "uniform4iv": {
                "!type": "fn(location: +WebGLUniformLocation, v: [long])"
            },
            "uniformMatrix2fv": {
                "!type": "fn(location: +WebGLUniformLocation, transpose: +GLboolean, value: [+GLfloat])"
            },
            "uniformMatrix3fv": {
                "!type": "fn(location: +WebGLUniformLocation, transpose: +GLboolean, value: [+GLfloat])"
            },
            "uniformMatrix4fv": {
                "!type": "fn(location: +WebGLUniformLocation, transpose: +GLboolean, value: [+GLfloat])"
            },
            "useProgram": {
                "!type": "fn(program: +WebGLProgram)"
            },
            "validateProgram": {
                "!type": "fn(program: +WebGLProgram)"
            },
            "vertexAttrib1f": {
                "!type": "fn(indx: +GLuint, x: +GLfloat)"
            },
            "vertexAttrib1fv": {
                "!type": "fn(indx: +GLuint, values: [+GLfloat])"
            },
            "vertexAttrib2f": {
                "!type": "fn(indx: +GLuint, x: +GLfloat, y: +GLfloat)"
            },
            "vertexAttrib2fv": {
                "!type": "fn(indx: +GLuint, values: [+GLfloat])"
            },
            "vertexAttrib3f": {
                "!type": "fn(indx: +GLuint, x: +GLfloat, y: +GLfloat, z: +GLfloat)"
            },
            "vertexAttrib3fv": {
                "!type": "fn(indx: +GLuint, values: [+GLfloat])"
            },
            "vertexAttrib4f": {
                "!type": "fn(indx: +GLuint, x: +GLfloat, y: +GLfloat, z: +GLfloat, w: +GLfloat)"
            },
            "vertexAttrib4fv": {
                "!type": "fn(indx: +GLuint, values: [+GLfloat])"
            },
            "vertexAttribPointer": {
                "!type": "fn(indx: +GLuint, size: +GLint, type: +GLenum, normalized: +GLboolean, stride: +GLsizei, offset: +GLintptr)"
            },
            "viewport": {
                "!type": "fn(x: +GLint, y: +GLint, width: +GLsizei, height: +GLsizei)"
            },
        }
    },
}

/* }}}1 */

var tern_gltutor = {
    "!name": "gltutor",
    "gl": {
        "!type": "+WebGLRenderingContext",
        "!doc": "The current drawing context."
    },
}
_.each (["PI", "E", "cos", "pow", "log", "tan", "sqrt", "ceil", "asin", "abs", "max", "exp", "atan2", "random", "round", "floor", "acos", "atan", "min", "sin"], function(f) {
    tern_gltutor[f] = tern_ecma5.Math[f];
});

var tern_defs = [tern_ecma5, tern_lodash, tern_webgl, tern_gltutor]


var updateErrorPos = function() {};

function draw() {
    queue.clear();
    if (!editor || !gl)
        return;

    $("#console").html("");
    _.each(errorLines, function(editorErrorLine) {
        editorErrorLine[0].removeLineClass(editorErrorLine[1], "background", null);
    });
    errorLines = [];


    initcanvas();
    var code = editor.getValue();//"";//$("#code").val();

    var displayError = function(editor, start_pos, end_pos, message) {
        errorLineMsg.find(".message").html(message);

        updateErrorPos = function() {
            if (start_pos.line == end_pos.line) {
                var start_coords = editor.charCoords(start_pos, "page")
                var end_coords = editor.charCoords(end_pos, "page");

                editor.addWidget(start_pos, errorLineMsg[0], true);
                errorLineMsg.find(".underline").show().css({
                    "width": end_coords.left - start_coords.left,
                });
            } else {
                editor.addWidget({line: end_pos.line, ch: 0}, errorLineMsg[0], true);
                errorLineMsg.find(".underline").hide();
            }
        };
        updateErrorPos();

        if (errorLineMsg.is(":hidden")) {
            errorLineMsg.show();//fadeIn(100)
        }
        //editor.addWidget(pos, errorLineMsg.get(0), false);
    }
    

    var prog = gl.createProgram();
    var addshader = function(type, editor) {
        var shader = gl.createShader(type);
        gl.shaderSource(shader, editor.getValue());
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            var log = gl.getShaderInfoLog(shader);

            if (console && console.log) console.log(log);

            var shaderRe = /ERROR: (\d+):(\d+): (.*)/;
            var err = shaderRe.exec(log)

            if (!err)
                print(log);
            
            var start_pos = {line:err[2]-1, ch:0};
            var end_pos = editor.posFromIndex(editor.indexFromPos({line:err[2], ch:0})-1);

            for (var line = start_pos.line; line <= end_pos.line; line++)
                errorLines.push([editor, editor.addLineClass(line, "background", "error")]);
            displayError(editor, start_pos, end_pos, "Shader Error: " + err[3]);

            errorLineMsg.removeClass("runtime");
        }
        gl.attachShader(prog, shader);
    };
    addshader(gl.VERTEX_SHADER, vs_editor);
    addshader(gl.FRAGMENT_SHADER, fs_editor);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        print("Could not link the shader program!");
        return;
    }
    gl.useProgram(prog);
    
    try {

        code = injectErrorChecks(code, {});//sandbox_funcs);
        if (debugCodeInjection)
            console.log(code);
        try {
            _.each (["PI", "E", "cos", "pow", "log", "tan", "sqrt", "ceil", "asin", "abs", "max", "exp", "atan2", "random", "round", "floor", "acos", "atan", "min", "sin"], function(f) {
                sandbox.global[f] = Math[f];
            });
            sandbox.global["gl"] = gl;
            sandbox.global["print"] = print;
            sandbox.global["printStackTrace"] = printStackTrace;
            sandbox.global["console"] = console;
            sandbox.global["_"] = _;

            sandbox.global["Matrix3"] = vecmath.Matrix3;
            sandbox.global["Matrix4"] = vecmath.Matrix4;
            sandbox.global["Quaternion"] = vecmath.Quaternion;
            sandbox.global["Vector2"] = vecmath.Vector2;
            sandbox.global["Vector3"] = vecmath.Vector3;
            sandbox.global["Vector4"] = vecmath.Vector4;
            
            sandbox.global["WIDTH"] = canvas.attr("width");
            sandbox.global["HEIGHT"] = canvas.attr("height");


            sandbox.eval("\"use strict\";\n"+code)
            //var f = new Function("__sandbox_funcs", "window", "\"use strict\";\n"+code);
            //f(sandbox_funcs);
            $("#codeerr").html("");
            queue.add(function() { if (curExecuting) curExecuting.clear() });

            errorLineMsg
                .hide()
                .removeClass("runtime");
                //fadeOut(100, function() { $(this).removeClass("runtime"); });

        } catch (runtime_err) {
            if (console && console.log) console.log(runtime_err)
            var start_pos, end_pos;
            if (runtime_err.range) {
                start_pos = editor.posFromIndex(runtime_err.range[0]);
                end_pos = editor.posFromIndex(runtime_err.range[1]);

                for (var line = start_pos.line; line <= end_pos.line; line++)
                    errorLines.push([editor, editor.addLineClass(line, "background", "runtimeerror")]);

                displayError(editor, start_pos, end_pos, "Runtime Error: Line " + (end_pos.line+1) + ": " + runtime_err.message)

                errorLineMsg.addClass("runtime");
            }
        }
    } catch (parse_err) {
        if (console && console.log) console.log(parse_err)
        if (!parse_err.index)
            throw parse_err;

        var pos = editor.posFromIndex(parse_err.index);
        displayError(editor, pos, {line:pos.line, ch:pos.ch+1}, "Parsing Error: " + parse_err.message )
        errorLines.push([editor, editor.addLineClass(pos.line, "background", "error")]);

        errorLineMsg.removeClass("runtime");
    }
}

$().ready(function() {
    //$("#code").change(function(e) {
    //    draw();
    //});
    canvas = $("#canvas");
    overlay = $("#overlay");
    errorLineMsg = $("#errorLineMsg");

    gl = null;

    try {
        // Try to grab the standard context. If it fails, fallback to experimental.
        gl = canvas[0].getContext("webgl") || canvas[0].getContext("experimental-webgl");
    }
    catch(e) {
        console.log(e);
    }

    // If we don't have a WebGL context, give up now
    if (!gl) {
        $("#notification")
            .html("Unable to initialize WebGL. Your browser may not support it.")
            .centre($("#codepanel"), window)
            .show();
        gl = null;
    }

    for (var key in tern_webgl.WebGLRenderingContext.prototype) {
        if (!tern_webgl.WebGLRenderingContext.prototype.hasOwnProperty(key)) continue;

        if (!(key in gl.constructor.prototype)) {
            console.log("gl." + key + " is not supported, removing from definitions");
            delete tern_webgl.WebGLRenderingContext.prototype[key];
        }
    }

    for (var key in gl.constructor.prototype) {
        if (!gl.constructor.prototype.hasOwnProperty(key)) continue;

        if (!(key in tern_webgl.WebGLRenderingContext.prototype)) {
            console.log("gl." + key + " is not defined");
        } 
    }

    $('#advancedOptions').hide();
    $('#advancedOptionsLink').click(function() {
        var advancedOptions = $('#advancedOptions');
        if (advancedOptions.is(":hidden")) {
            advancedOptions.show();
            
            var win = $(window);

            var viewport = {
                top : win.scrollTop(),
                left : win.scrollLeft()
            };
            viewport.right = viewport.left + window.innerWidth;
            viewport.bottom = viewport.top + window.innerHeight;

            var bounds = advancedOptions.offset();
            bounds.right = bounds.left + advancedOptions.outerWidth();
            bounds.bottom = bounds.top + advancedOptions.outerHeight();;

            if (bounds.bottom > viewport.bottom)
                $("body").animate({scrollTop: viewport.top + (bounds.bottom - viewport.bottom) })
            advancedOptions.hide().slideDown();


        } else {
            advancedOptions.slideUp();
        }
        return false;
    });

    $("#accurateRuntimeChecks").prop("checked", accurateRuntimeChecks)
                               .change(function(e) { accurateRuntimeChecks = this.checked; draw() });
    $("#debugCodeInjection").prop("checked", debugCodeInjection)
                            .change(function(e) { debugCodeInjection = this.checked; draw() });




    // create the editor
    editor = CodeMirror.fromTextArea(document.getElementById("code"), {
        mode: "javascript",
        lineNumbers: true,
        matchBrackets: true,
        indentUnit: 4,
        lineWrapping: true,
    });
    editor.on("change", _.throttle(function(self, changeObj) {
                                       draw();
                                   },200));

    server = new CodeMirror.TernServer({defs:tern_defs});
    editor.setOption("extraKeys", {
      "Ctrl-Space": function(cm) { server.complete(cm); },
      "Ctrl-I": function(cm) { server.showType(cm); },
      "Alt-.": function(cm) { server.jumpToDef(cm); },
      "Alt-,": function(cm) { server.jumpBack(cm); },
      "Ctrl-Q": function(cm) { server.rename(cm); },
      "Ctrl-.": function(cm) { server.selectName(cm); }
    })
    editor.on("cursorActivity", function(self, changeObj) {
        server.updateArgHints(self);
    });

    editor.on("mousedown", function(self, event) {
       if (event.ctrlKey) {
           if (!self.somethingSelected()) {
               self.setCursor(self.coordsChar({left:event.pageX, top:event.pageY}));
               server.jumpToDef(self);
               event.preventDefault();
           }
       }
    });

    vs_editor = CodeMirror.fromTextArea(document.getElementById("code_vertexshader"), {
        mode: "x-shader/x-vertex",
        lineNumbers: true,
        matchBrackets: true,
        indentUnit: 4,
        lineWrapping: true,
    });
    vs_editor.on("change", _.throttle(function(self, changeObj) {
                                       draw();
                                   },200));

    fs_editor = CodeMirror.fromTextArea(document.getElementById("code_fragmentshader"), {
        mode: "x-shader/x-fragment",
        lineNumbers: true,
        matchBrackets: true,
        indentUnit: 4,
        lineWrapping: true,
    });
    fs_editor.on("change", _.throttle(function(self, changeObj) {
                                       draw();
                                   },200));

    var mousePos = [0,0];
    var updateErrorOpacity = function() {

        var msgBounds = errorLineMsg.find(".message").bounds();
        var editors = _([editor, vs_editor, fs_editor]);

        var mouseDist = msgBounds.distance(mousePos[0], mousePos[1])

        var selRects = _([]);
        editors.each(function(e) {
            var selections; 
            if (e.somethingSelected())
                selections = _(e.listSelections());
            else
                selections = _([{head: e.getCursor("head"), anchor: e.getCursor("anchor")}]);

            selections.each(function(sel) {
                var start = sel.head;
                var end = sel.anchor;

                if (start.line > end.line || start.line == end.line && start.ch > end.ch) {
                    var tmp = start;
                    start = end;
                    end = tmp;
                }

                var start_coords = e.charCoords(start);
                var end_coords = e.charCoords(end);
                if (start.line == end.line) {
                    selRects.push(new Rect(start_coords.top,
                                           start_coords.left,
                                           end_coords.right - start_coords.left,
                                           end_coords.bottom - start_coords.top));
                } else {
                    selRects.push(new Rect(start_coords.top,
                                           0,
                                           e.getScrollInfo().clientWidth,
                                           end_coords.bottom - start_coords.top));
                }
            });
        });

        var selDist = selRects.map(function(rect) {
            return msgBounds.rectDistance(rect);
        }).min();

        var opacity = Math.min(mouseDist / 10, selDist);
        opacity = Math.max(Math.min(opacity, 1.0), 0.2);
        errorLineMsg.find(".message").css({opacity: opacity});
    }

    $(window).mousemove(function(e) {
        mousePos = [e.pageX, e.pageY];
        updateErrorOpacity();
    });
    _.forEach([editor, vs_editor, fs_editor], function(e) {
        e.on("cursorActivity", function(self, event) {
            updateErrorOpacity();
        });
    });

    $("#notification").hide();

    if(typeof(Storage)!=="undefined")
    {
        if (localStorage.gltutor_code)
            editor.setValue(localStorage.gltutor_code)
        if (localStorage.gltutor_code_vs)
            vs_editor.setValue(localStorage.gltutor_code_vs)
        if (localStorage.gltutor_code_fs)
            fs_editor.setValue(localStorage.gltutor_code_fs)

        $(document).keydown(function(e) {
            if (!((event.ctrlKey || event.metaKey) && event.keyCode==83))
                return true;

            localStorage.gltutor_code = editor.getValue();
            localStorage.gltutor_code_vs = vs_editor.getValue();
            localStorage.gltutor_code_fs = fs_editor.getValue();

            event.preventDefault();

            $("#notification")
                .html("Saved!")
                .centre($("#codepanel"), window)
                .fadeIn(200)
                .delay(600)
                .fadeOut(600);

            return false;
        });
    }

    $(window).resize(_.debounce(function(e) {
        draw();
    },100));

    draw();
});

})();
