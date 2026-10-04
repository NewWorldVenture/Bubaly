'use strict';

const utils = require('./utils');
const DEFAULT_MAX_DEPTH = 100;

module.exports = (ast, options = {}) => {
  const maxDepth = options.maxDepth === undefined ? DEFAULT_MAX_DEPTH : options.maxDepth;
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new TypeError('options.maxDepth must be a non-negative integer');
  }
  const stringify = (node, parent = {}, depth = 0) => {
    if (depth > maxDepth) throw new RangeError(`AST nesting exceeds max depth (${maxDepth})`);
    const invalidBlock = options.escapeInvalid && utils.isInvalidBrace(parent);
    const invalidNode = node.invalid === true && options.escapeInvalid === true;
    let output = '';

    if (node.value) {
      if ((invalidBlock || invalidNode) && utils.isOpenOrClose(node)) {
        return '\\' + node.value;
      }
      return node.value;
    }

    if (node.value) {
      return node.value;
    }

    if (node.nodes) {
      for (const child of node.nodes) {
        // Keep the original parent semantics: escapeInvalid historically does
        // not inherit a parent's invalidity through ordinary child recursion.
        output += stringify(child, undefined, depth + (child.nodes ? 1 : 0));
      }
    }
    return output;
  };

  return stringify(ast);
};
