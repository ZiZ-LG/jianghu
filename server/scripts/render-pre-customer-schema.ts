import { readFile, writeFile } from 'node:fs/promises';

const sourcePath = process.argv[2];
const outputPath = process.argv[3];
if (!sourcePath || !outputPath) throw new Error('source and output schema paths are required');

const source = await readFile(sourcePath, 'utf8');
const expandedFields = `  categoryKey        String?\n  customerType       Int?\n  version            Int                 @default(0)`;
const legacyField = '  customerType       Int';
if (source.split(expandedFields).length !== 2) {
  throw new Error('current Account Customer expansion shape is not unique');
}
await writeFile(outputPath, source.replace(expandedFields, legacyField));
