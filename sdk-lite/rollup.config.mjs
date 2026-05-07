// import { defineConfig } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';

import typescript from '@rollup/plugin-typescript';

function relay() {
  return {
    name: 'relay',
    transform(code) {
      // console.log("code", code);
      // Use indexOf as its probably ;-) faster
      if (code.indexOf('graphql`') > -1 || code.indexOf('graphql `') > -1) {
        // console.log("code", code);
        // throw new Error("test");
        const re = /graphql\s*`[^`]+(?<type>query|fragment|mutation|subscription)\s+(?<name>[\w_-\d]+)[^`]+`/gm;

        let imports = [];

        let transformedCode = code.replace(re, (matchStr, _g1, _g2, _pos, _code, groups) => {
            const importName = `__graphql__${groups.name}__`;

            imports.push(
              `import ${importName} from './__generated__/${groups.name}.graphql.ts';`
            );
            return importName;
        });

        if (imports.length > 0) {
          transformedCode += `
            ${imports.join('\n')}
          `;
        }

        return { code: transformedCode };
      }

      return null;
    }
  };
}

export default {
  input: 'src/index.ts',
  output: {
    dir: 'dist',
    format: 'esm',
  },
  plugins: [
    typescript({
      compilerOptions: {
        declaration: true,
        declarationDir: "dist",
        noEmit: false,
        outDir: "dist",
      },
    }),
    relay(),
    // nodeResolve()
  ],
};
