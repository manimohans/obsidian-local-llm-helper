import { RAGManager } from './rag';
import { TFile, Vault } from 'obsidian';

export class BacklinkGenerator {
	constructor(private ragManager: RAGManager, private vault: Vault) { }

	async generateBacklinks(selectedText: string): Promise<string[]> {
		const similarNotes = await this.ragManager.findSimilarNotes(selectedText);
		console.log("Similar notes:", similarNotes);
		const backlinks: string[] = [];

		// Split the similarNotes string into individual note entries
		const noteEntries = similarNotes.split('\n').filter(entry => entry.trim() !== '');

		for (const entry of noteEntries) {
			console.log("Processing note entry:", entry);
			// Extract the file path from the entry (assuming it's in the format [[filepath]]: content)
			const match = entry.match(/\[\[(.*?)\]\]/);
			if (match && match[1]) {
				const notePath = match[1];
				const file = this.vault.getAbstractFileByPath(notePath);
				if (file instanceof TFile) {
					console.log("File found:", file.path);
					backlinks.push(`[[${file.path}|${file.basename}]]`);
				} else {
					console.log("File not found or not a TFile:", notePath);
				}
			}
		}
		console.log("Generated backlinks:", backlinks);
		return backlinks;
	}
}
