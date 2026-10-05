/**
 * Structural self-check for the generated documents.
 *
 * Not a full OpenAPI validator — it targets the mistakes this converter can
 * actually make, so a broken build is caught before it reaches the UI.
 */

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

export function validateDocument(doc) {
  const problems = [];
  const operationIds = new Set();
  const declaredSchemes = new Set(Object.keys(doc.components?.securitySchemes || {}));
  const declaredTags = new Set((doc.tags || []).map((t) => t.name));

  if (!doc.servers?.length) problems.push('no hay servidores definidos');

  for (const [routePath, pathItem] of Object.entries(doc.paths || {})) {
    if (!routePath.startsWith('/')) problems.push('ruta sin barra inicial: ' + routePath);

    const templated = new Set((routePath.match(/\{([^}]+)\}/g) || []).map((m) => m.slice(1, -1)));

    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue;
      const where = method.toUpperCase() + ' ' + routePath;

      if (!operation.responses || !Object.keys(operation.responses).length) {
        problems.push(where + ': sin responses');
      }

      if (operation.operationId) {
        if (operationIds.has(operation.operationId)) {
          problems.push(where + ': operationId duplicado "' + operation.operationId + '"');
        }
        operationIds.add(operation.operationId);
      }

      for (const tag of operation.tags || []) {
        if (!declaredTags.has(tag)) problems.push(where + ': tag no declarado "' + tag + '"');
      }

      const declaredParams = new Set(
        (operation.parameters || []).filter((p) => p.in === 'path').map((p) => p.name),
      );
      for (const name of templated) {
        if (!declaredParams.has(name)) problems.push(where + ': falta el path param {' + name + '}');
      }
      for (const name of declaredParams) {
        if (!templated.has(name)) problems.push(where + ': path param sobrante "' + name + '"');
      }

      for (const requirement of operation.security || []) {
        for (const scheme of Object.keys(requirement)) {
          if (!declaredSchemes.has(scheme)) {
            problems.push(where + ': security scheme no declarado "' + scheme + '"');
          }
        }
      }
    }
  }

  return problems;
}
