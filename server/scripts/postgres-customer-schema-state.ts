import { prisma } from '../src/prisma.js';

type ColumnRow = {
  columnName: string;
  dataType: string;
  isNullable: 'YES' | 'NO';
  columnDefault: string | null;
};
type TableRow = { tableCount: number | bigint | string };

try {
  const tableRows = await prisma.$queryRawUnsafe<TableRow[]>(`
    SELECT COUNT(*) AS "tableCount"
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'Account'
  `);
  const rows = await prisma.$queryRawUnsafe<ColumnRow[]>(`
    SELECT
      column_name AS "columnName",
      data_type AS "dataType",
      is_nullable AS "isNullable",
      column_default AS "columnDefault"
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'Account'
       AND column_name IN ('categoryKey', 'customerType', 'version')
  `);
  const columns = new Map(rows.map((row) => [row.columnName, row]));
  const category = columns.get('categoryKey');
  const sales = columns.get('customerType');
  const version = columns.get('version');
  const validSalesType = sales?.dataType === 'integer';
  const tableCount = Number(tableRows[0]?.tableCount ?? 0);
  if (tableCount === 0 && rows.length === 0) {
    process.stdout.write('legacy');
  } else if (tableCount === 1 && rows.length === 1 && validSalesType && sales?.isNullable === 'NO') {
    process.stdout.write('legacy');
  } else if (
    rows.length === 3
    && category?.dataType === 'text'
    && category.isNullable === 'YES'
    && validSalesType
    && sales?.isNullable === 'YES'
    && version?.dataType === 'integer'
    && version.isNullable === 'NO'
    && /^0(?:::\w+)?$/.test(version.columnDefault ?? '')
  ) {
    process.stdout.write('expanded');
  } else {
    process.stdout.write('partial');
  }
} finally {
  await prisma.$disconnect();
}
