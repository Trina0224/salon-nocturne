// Prints the SQL for a D1 Time Travel recovery (docs/deployment.md). It only
// reads a local file and writes to stdout; it never contacts Cloudflare.
//
//   node scripts/recovery-sql.ts capture              # one-line SQL to run on the live DB first
//   node scripts/recovery-sql.ts reapply capture.json # SQL to run on the restored DB
//   node scripts/recovery-sql.ts verify capture.json  # one-line check; every column must be 0
import { readFileSync } from 'node:fs';
import { CAPTURE_SQL, parseCapture, reapplySql, verifySql } from '../src/ops/recovery.ts';

const [command, file] = process.argv.slice(2);
if (command === 'capture') {
  process.stdout.write(`${CAPTURE_SQL.replace(/\s*\n\s*/g, ' ')}\n`);
} else if ((command === 'reapply' || command === 'verify') && file) {
  const capture = parseCapture(readFileSync(file, 'utf8'));
  process.stdout.write(command === 'reapply' ? reapplySql(capture) : `${verifySql(capture).replace(/\s*\n\s*/g, ' ')}\n`);
} else {
  process.stderr.write('usage: recovery-sql.ts capture | reapply <capture.json> | verify <capture.json>\n');
  process.exit(2);
}
