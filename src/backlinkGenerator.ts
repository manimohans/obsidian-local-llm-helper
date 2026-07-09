import { RAGManager } from './rag';
import { TFile, Vault } from 'obsidian';

export class BacklinkGenerator {
	constructor(private ragManager: RAGManager, private vault: Vault) { }

	async generateBacklinks(selectedText: string): Promise<string[]> {
		const relatedNotes = (await this.ragManager.findRelatedNotes(selectedText))
			.filter(note => note.sourceType === "markdown");

		const backlinks: string[] = [];
		for (const note of relatedNotes) {
			const file = this.vault.getAbstractFileByPath(note.path);
			if (file instanceof TFile) {
				backlinks.push(`[[${file.path}|${file.basename}]]`);
			}
		}
		return backlinks;
	}
}
