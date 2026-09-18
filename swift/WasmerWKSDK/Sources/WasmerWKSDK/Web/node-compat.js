// Node's HTTP/readline builtins reference these symbols even when no `using`
// statement is executed. Older host engines may expose JSPI before disposal
// symbols. Supply the missing identities before Edge.js captures primordials;
// this does not implement explicit-resource-management syntax in the engine.
export function installNodeSymbols(symbol = Symbol) {
  const installed = [];
  for (const name of ["dispose", "asyncDispose"]) {
    if (typeof symbol[name] === "symbol") continue;
    Object.defineProperty(symbol, name, { value: symbol(`Symbol.${name}`) });
    installed.push(name);
  }
  return installed;
}

installNodeSymbols();
