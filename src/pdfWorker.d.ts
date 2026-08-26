/**
 * pdfjs-dist ships pdf.d.mts next to pdf.mjs but nothing next to pdf.worker.mjs, and
 * this project's `moduleResolution: "node"` ignores the package exports map. Without
 * this declaration tsc would fall back to type-checking the 2 MB worker bundle itself.
 * Only the one export we rely on is declared.
 */
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
	export const WorkerMessageHandler: unknown;
}
