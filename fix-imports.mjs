import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, 'apps/api/src');

function fixImports(dir) {
  const files = fs.readdirSync(dir, { recursive: true });
  for (const file of files) {
    if (file.endsWith('.ts') && !file.includes('node_modules')) {
      const fullPath = path.join(dir, file);
      let content = fs.readFileSync(fullPath, 'utf8');
      
      // Fix relative imports by adding .js extension
      content = content.replace(/from\s+['"]\.\/([^'"]+)['"]/g, (match, p1) => {
        if (!p1.endsWith('.js') && !p1.endsWith('.json')) {
          return `from '${p1}.js'`;
        }
        return match;
      });
      
      fs.writeFileSync(fullPath, content, 'utf8');
    }
  }
}

fixImports(srcDir);
console.log('Fixed imports');
