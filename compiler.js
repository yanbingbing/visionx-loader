const fs = require('fs');
const path = require('path');
const traverse = require('@babel/traverse').default;
const builtinGlobals = require('globals');
const Scope = require('@babel/traverse').Scope;
const generate = require('@babel/generator').default;
const types = require('@babel/types');
const babylon = require('./babylon');

const origAddGlobal = Scope.prototype.addGlobal;
Scope.prototype.addGlobal = function addGlobal(node) {
  origAddGlobal.call(this, node);
  if (builtinGlobals.es2017[node.name] === false || builtinGlobals.browser[node.name] === false) {
    return;
  }
  if (!this.xglobals) {
    this.xglobals = [];
  }
  this.xglobals.push(node);
};

// 模型识别mid
function mid(states) {
  return 'm' + (states.MID++);
}

// model 挂载 key，scope下唯一
function getInstanceKey(key) {
  if (key) {
    return key;
  }
  return key || Date.now();
}

function generateImports(imports) {
  const maps = {};
  const keys = [];
  imports.forEach((config) => {
    const key = config.from;
    if (!key) return;
    if (!maps[key]) {
      maps[key] = { from: key };
      keys.push(maps[key]);
    }
    if (config.name) {
      maps[key].name = config.name;
    }
    if (config.member) {
      const items = config.member.trim().split(/ *, */);
      if (!maps[key].member && items.length > 0) {
        maps[key].member = new Set(items);
      } else if (items.length > 0) {
        items.forEach(item => maps[key].member.add(item));
      }
    }
  });
  return keys.map(k => {
    let im = [];
    if (k.name) {
      im.push(k.name);
    }
    if (k.member && k.member.size > 0) {
      im.push(`{${Array.from(k.member).join(', ')}}`);
    }

    return `import ${im.join(', ')} from '${k.from}';`;
  }).join('\n');
}

function parseJsxExpression(ast, action = false) {
  // todo: parse react in expression
  let globals;
  let programUid;
  let reactive = false;
  ast = types.returnStatement(ast);
  traverse({
    type: 'File',
    program: {
      type: 'Program',
      body: [ast]
    }
  }, {
    Program(path) {
      globals = path.scope.xglobals || [];
      if (globals.length > 0) {
        reactive = true;
      }
      programUid = path.scope.uid;
    },
    ThisExpression(path) {
      // todo:
      if (path.scope.uid === programUid) {
        reactive = true;
      }
    },
    Identifier(path) {
      const name = path.node.name;
      if (globals && name !== '$scope' && name !== '$model' && globals.indexOf(path.node) > -1) {
        path.replaceWith(types.MemberExpression(
          types.identifier('$scope'),
          types.identifier(name)
        ));
      }
    },
    CallExpression(path) {
      let isActionBind = false;
      let calleeNode = path.node.callee;
      if (types.isIdentifier(calleeNode)) {
        isActionBind = calleeNode.name === '$action';
      } else if (types.isMemberExpression(calleeNode)) {
        isActionBind = calleeNode.object.name === '$scope' && calleeNode.property.name === '$action';
      }
      if (isActionBind) {
        path.pushContainer('arguments', types.identifier('$model'));
      }
    },
  });
  if (action) {
    ast = types.functionExpression(
      null,
      [types.identifier('$scope'), types.identifier('$model')],
      types.blockStatement([
        types.returnStatement(
          types.callExpression(
            types.memberExpression(
              types.identifier('$scope'),
              types.identifier('$action')
            ),
            [ast.argument, types.identifier('$model')]
          )
        )
      ]),
    );
    return { reactive: true, ast };
  }
  if (reactive) {
    ast = types.functionExpression(null,
      [types.identifier('$scope'), types.identifier('$model')],
      types.blockStatement([ast]),
    );
  } else {
    ast = ast.argument;
  }

  return { reactive, ast };
}

function readModuleSource(ast, moduleConfig) {
  moduleConfig.source = ast.length > 0 ? tocode(ast).trim() : '';
}

function getVxAST(contents) {
  if (!contents) {
    return null;
  }
  return babylon.parse(contents.trim(), {
    jsxTopLevel: true,
    plugins: [
      'jsx',
      'optionalChaining',
      'decorators',
      'objectRestSpread',
      'pipelineOperator',
    ]
  });
}

function readFile(file, callback) {
  fs.readFile(file, 'utf8', function (err, source) {
    if (err) return callback('');
    callback(source.trim());
  });
}

function tryfiles(resolver, files, callback) {
  function stat() {
    var file = files.shift();

    if (!file) {
      return callback(null);
    }

    resolver(file, function (filepath) {
      if (filepath) {
        return callback(filepath);
      }
      stat();
    });
  }

  stat();
}

function getModuleSource(modules, resolver, callback) {
  let validModule;
  while (validModule = modules.pop()) {
    if (validModule.source !== '' || validModule.main) {
      break;
    }
  }
  let moduleSource;
  if (validModule && !validModule.main) {
    return callback(validModule.source);
  }

  const exts = ['.js', '.ts', '.jsx', '.tsx'];
  const files = [];
  if (validModule && validModule.main) {
    const ext = path.extname(validModule.main);
    if (exts.indexOf(ext) < 0) {
      exts.forEach(ext => files.push(file + ext));
    } else {
      files.push(file);
    }
  }
  exts.forEach(ext => files.push('index' + ext));
  tryfiles(resolver, files, (file) => {
    if (file) {
      resolver.addDependency(file);
      readFile(file, callback);
    } else {
      callback('');
    }
  });
}

// region compile
function compile(resolver, source, callback) {
  const renders = [];
  const models = [];
  const modules = [];
  const imports = [
    { from: 'react', name: '* as React' },
    { from: '@recore/vision-react', member: 'VisionX, VisionView, VisionIf, VisionFor' },
  ];
  const states = {
    funcId: 0,
    MID: 0
  };
  const ast = getVxAST(source);
  if (!ast) {
    return callback('export const render = function(scope) {return null}');
  }

  let children = buildChildTree(states, imports, modules, renders, models, ast.program.body);
  if (children.length > 0) {
    children = `[\n    ${children.join(',\n    ')},\n  ]`;
  } else {
    children = 'null';
  }

  renders.push(
`return (scope) => {
  return ${children};
}`);

  getModuleSource(modules, resolver, (moduleSource) => {
    if (moduleSource) {
      moduleSource += '\n\n';
    }
    const contents = generateImports(imports)
      + '\n\n'
      + moduleSource
      + 'export const render = (function() {'
      + '\n\nconst M = {\n' + models.join('') + '};\n\n'
      + renders.join('\n\n') + '\n'
      + '})();';

    callback(contents);
  });
}
// endregion

// region buildDelegate
function buildDelegate(states, key, children, renders, selfScope = false) {
  const  delegateName = `delegate_${key.toLowerCase()}_${states.funcId++}`;
  let content;
  if (children.length > 1) {
    content = `[\n    ${children.join(',\n    ')},\n  ]`;
  } else {
    content = children[0] || 'null';
  }

  if (selfScope) {
    renders.push(
`function ${delegateName}(m){
  const { scope } = m;
  return (${content});
}`);
  } else {
    renders.push(
`function ${delegateName}(m,key,data){
  const scope = m.getChild(key, data);
  return (${content});
}`);
  }

  return delegateName;
}
// endregion

function buildChildTree(
  states, imports, modules, renders, models, childrenAST,
  depth = 0, childrenAsDelegate = false, delegatesReturn = [], preserve = false
) {
  const children = [];
  const delegates = {};
  let fragments = [];
  let index = 0;

  function pushChild(r) {
    if (r.delegateFor || childrenAsDelegate) {
      let key = `'${r.key}-' + key`;
      let delegateName = r.delegateFor || childrenAsDelegate;
      if (!delegates[delegateName]) {
        delegates[delegateName] = [];
      }
      delegates[delegateName].push(
        `<VisionX key={${key}} model={scope.$model(${key}, M.${r.umid})} renderContent={${r.renderName}} />`
      );
    } else {
      children.push(
        `<VisionX key="${r.key}" model={scope.$model('${r.key}', M.${r.umid})} renderContent={${r.renderName}} />`
      );
    }
    index++;
  }

  function completeFragments() {
    if (fragments.length < 1 || fragments.every((item) => item.content.trim() === '')) {
      fragments = [];
      return;
    }

    pushChild(buildFragments(states, renders, models, fragments, depth, index));
    fragments = [];
  }

  for (let i = 0, l = childrenAST.length; i < l; i++) {
    let item = childrenAST[i];
    if (types.isJSXText(item)) {
      fragments.push({ content: item.value });
      continue;
    }

    if (types.isJSXExpressionContainer(item)) {
      const frag = parseExpressionFragment(item.expression, index);
      if (frag) {
        fragments.push(frag);
      }
      continue;
    }

    completeFragments();

    if (types.isJSXElement(item)) {
      const r = buildElementTree(states, imports, modules, renders, models, item, depth, index);
      if (r) {
        pushChild(r);
      }
      continue;
    }
    // ignore others, react not support yet
  }

  completeFragments();

  Object.keys(delegates).forEach(key => {
    delegatesReturn.push({
      delegateFor: key,
      renderName: buildDelegate(states, key, delegates[key], renders),
    });
  });

  return children;
}

const directivesDefaults = {
  'v-delegate': 'childrenDelegate',
  'v-delegate-container': 'childrenDelegate',
  'v-for-item': 'item',
  'v-for-each': 'item',
  'v-for-index': 'index',
  'v-nest-preserve': true,
  'each': 'item',
  'index': 'index',
};

const directivesMap = {
  'v-for-item': 'each',
  'v-for-each': 'each',
  'v-for-index': 'index',
  'v-for': 'of',
  'v-if': 'condition',
};

function parseAttributes(attrAST, directives, extraConfig) {
  const attributes = [];

  attrAST.forEach((attr) => {
    let config = [];
    if (types.isJSXSpreadAttribute(attr)) {
      if (extraConfig) {
        throw "Not allow spread attribute in import";
      }
      const r = parseJsxExpression(attr.argument);
      config.push((r.reactive ? 'expr': 'value') + ':' + tocode(r.ast));
      config.push('spread:true');
      attributes.push('{' + config.join(',') + '}');
      return;
    }

    let name = getJSXIdentifier(attr.name);

    // action binding
    if (name[0] === '@') {
      name = name.substr(1);
      if (!extraConfig) {
        config.push(`name:'${name}'`);
        if (attr.value && types.isJSXExpressionContainer(attr.value)) {
          const r = parseJsxExpression(attr.value.expression, true);
          config.push('expr:' + tocode(r.ast));
        } else {
          let action;
          if (!attr.value) {
            action = name;
          } else if (types.isStringLiteral(attr.value)) {
            action = attr.value.value;
          }
          config.push(`expr:function($scope,$model){return $scope.$action('${action}',$model)}`);
        }
        attributes.push('{' + config.join(',') + '}');
        return;
      }
    }

    if (name in directives) {
      config.push(`name:'${directivesMap[name] || name}'`);
    } else {
      config.push(`name:'${name}'`);
    }
    // normal property
    if (attr.value && types.isJSXExpressionContainer(attr.value)) {
      // is a directive, and can not be expression
      if (directives[name] === 0 || extraConfig) {
        throw `Cannot use expression here ${typeName}:${name}`;
      }
      const r = parseJsxExpression(attr.value.expression);
      config.push((r.reactive ? 'expr': 'value') + ':' + tocode(r.ast));
    } else {
      if (extraConfig) {
        extraConfig[name] = !attr.value ? true : attr.value.value;
      } else if (directives[name] === 0) {
        directives[name] = !attr.value ? directivesDefaults[name] : attr.value.value;
      } else {
        const val = !attr.value ? 'true' : `"${attr.value.value}"`;
        config.push('value:' + val);
      }
    }

    if (extraConfig) {
      return;
    }

    // directives
    if (name in directives) {
      if (directives[name] === null) {
        directives[name] = '{' + config.join(',') + '}';
      }
    } else {
      attributes.push('{' + config.join(',') + '}');
    }
  });

  return attributes;
}

// region buildElementTree
function buildElementTree(states, imports, modules, renders, models, jsxElementAST, depth = 0, index = 0, preserve = false) {
  let typeName = getJSXIdentifier(jsxElementAST.openingElement.name);
  const importConfig = typeName.toLowerCase() === 'import' ? {} : null;
  const moduleConfig = typeName.toLowerCase() === 'script' ? {} : null;
  const directives = {
    'v-for': null,
    'v-if': null,
    'v-delegate': 0,
    'v-delegate-container': 0,
    'v-for-item': 0,
    'v-for-each': 0,
    'v-for-index': 0,
    'v-model': 0,
    'v-id': 0,
    'v-nest-preserve': 0,
    'v-preserve': 0
  };
  if (typeName === 'If') {
    directives['condition'] = null;
  } else if (typeName === 'For') {
    directives['of'] = null;
    directives['each'] = 0;
    directives['index'] = 0;
  }

  let attributes = parseAttributes(
    jsxElementAST.openingElement.attributes,
    directives,
    importConfig || moduleConfig,
  );

  if (importConfig) {
    imports.push(importConfig);
    return null;
  }
  if (moduleConfig) {
    readModuleSource(jsxElementAST.children, moduleConfig);
    modules.push(moduleConfig);
    return null;
  }

  if (directives['v-if'] || directives['condition']) {
    depth++;
  }
  if (directives['v-for'] || directives['of']) {
    depth++;
  }
  if (typeName === 'If' || typeName === 'For' || typeName === 'View') {
    typeName = 'VisionView';
  }

  /*
  if (!preserve) {
    if (directives['v-preserve'] || !inImports(typeName, imports)) {
      preserve = true;
    }
  }
  */

  let renderName = `render_${typeName.toLowerCase()}_${states.funcId++}`;
  let umid = mid(states);
  let propsSpread = '{...data}';
  /*
  if (preserve) {
    propsSpread = `{...data._${umid}}`;
  }
  */

  let content;
  if (jsxElementAST.children && jsxElementAST.children.length > 0) {
    let delegates = [];
    let children = buildChildTree(
      states, imports, modules, renders, models, jsxElementAST.children,
      depth + 1, directives['v-delegate-container'], delegates, directives['v-nest-preserve']
    );
    delegates = delegates.map(item => ` ${item.delegateFor}={${item.renderName}}`).join(' ');
    if (children.length > 0) {
      let openContent = `    <${typeName} ${propsSpread}${delegates}>\n      `;
      let closeContent = `\n    </${typeName}>`;
      content = openContent + children.join('\n      ') + closeContent;
    } else {
      content = `    <${typeName} ${propsSpread}${delegates} />`;
    }
  } else {
    content = `    <${typeName} ${propsSpread} />`;
  }

  let matchString = typeName + (directives['v-model'] ? `:${directives['v-model']}` : '');
  let key = getInstanceKey(directives['v-id'] || umid);
  let render =
`function ${renderName}(m){
  const { scope, data } = m;
  return (
${content}
  );
}`;
  attributes = attributes.join(',\n    ');
  if (attributes) {
    attributes = `\n    ${attributes},\n  `;
  }

  models.push(`  ${umid}: ['${matchString}', [${attributes}], ${depth}],\n`);
  renders.push(render);

  if (directives['v-if'] || directives['condition']) {
    const delegateName = buildDelegate(states, key, [
      `<VisionX key="${key}" model={scope.$model('${key}', M.${umid})} renderContent={${renderName}} />`
    ], renders, true);
    const condition = directives['v-if'] || directives['condition'];
    renderName = `render_if_${states.funcId++}`;
    matchString = 'If';
    render =
`function ${renderName}(m){
  const { scope, data } = m;
  return (
    <VisionIf {...data} children={${delegateName}.bind(null, m)} />
  );
}`;
    umid = mid(states);
    key = getInstanceKey(umid);
    models.push(`  ${umid}: ['${matchString}', [${condition}], ${--depth}],\n`);
    renders.push(render);
/*
    render =
`function ${renderName}(m){
  return (m.data._${umid}.condition ? ${renderName}(m) : null)
}`
    if (preserve) {




    }
*/
  }

  if (directives['v-for'] || directives['of']) {
    const delegateName = buildDelegate(
      states, key,
      [`<VisionX key={'${key}-' + key} model={scope.$model('${key}-' + key, M.${umid})} renderContent={${renderName}} />`],
      renders
    );
    const forOf = directives['v-for'] || directives['of'];
    let forItem = directives['v-for-item'] || directives['v-for-each'] || directives['each'] || 'item';
    let forIndex = directives['v-for-index'] || directives['index'] || 'index';
    forItem = `{name:'each',value:'${forItem}'}`;
    forIndex = `{name:'index',value:'${forIndex}'}`;
    renderName = `render_for_${states.funcId++}`;
    matchString = 'For';
    render =
`function ${renderName}(m){
  const { scope, data } = m;
  return (
    <VisionFor {...data} itemDelegate={${delegateName}.bind(null, m)} />
  );
}`
    umid = mid(states);
    key = getInstanceKey(umid);
    models.push(`  ${umid}: ['${matchString}', [${forOf},${forItem},${forIndex}], ${--depth}],\n`);
    renders.push(render);
  }

  const ret = { umid, key, renderName };
  if (directives['v-delegate']) {
    ret.delegateFor = directives['v-delegate'];
  }
  return ret;
}
// endregion

// region buildFragments
function buildFragments(states, renders, models, fragments, depth, index) {
  const umid = mid(states);
  const matchString = 'VisionFragment';
  const key = getInstanceKey(umid);
  const renderName = `render_fragments_${states.funcId++}`;
  const contents = [];
  let attributes = [];
  fragments.forEach((frag) => {
    contents.push(frag.content);
    if (frag.expr) {
      attributes.push('{' + frag.expr.join(',') + '}');
    }
  });
  attributes = attributes.join(',\n    ');
  if (attributes) {
    attributes = `\n    ${attributes},\n  `;
  }

  const render =
`function ${renderName}(m){
  const { scope, data } = m;
  return (
    <React.Fragment>${contents.join('')}</React.Fragment>
  );
}`;
  models.push(`  ${umid}: ['${matchString}', [${attributes}], ${depth}],\n`);
  renders.unshift(render);

  return { umid, key, renderName };
}
// endregion

function parseExpressionFragment(expressionAST, index) {
  if (types.isJSXEmptyExpression(expressionAST)) {
    return null;
  }

  const name = `expr${index}`;
  const config = [`name:'${name}'`];
  const r = parseJsxExpression(expressionAST);
  config.push((r.reactive ? 'expr': 'value') + ':' + tocode(r.ast));
  return {
    content: `{data.${name}}`,
    expr: config,
  };
}

function tocode(ast) {
  return generate(ast, {
    // Should comments be included in output
    comments: false,
    // Should the output be minified
    minified: true,
    // Set to true to reduce whitespace
    // concise: true,
    // Set to true to avoid adding whitespace for formatting
    // compact: true,
  }).code;
}

function getJSXIdentifier(nameAST) {
  return generate(nameAST).code;
}

module.exports = compile;
