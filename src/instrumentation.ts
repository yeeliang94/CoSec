/** Starts the bulk import reader inside the web server process, wherever the app runs. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { startImportRunner } = await import('./server/imports/runner');
  startImportRunner();
}
