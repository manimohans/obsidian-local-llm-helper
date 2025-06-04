# Expected Behavior After Plugin Reload

## 🔄 When You Restart/Reload Obsidian

### 1. **Console Messages** (Developer Tools > Console)
You should see these messages in order:
```
🔌 LLM Helper: Plugin loading...
📂 LLM Helper: Loading plugin settings...
💾 LLM Helper: Raw saved data: [object with your settings]
✅ LLM Helper: Final settings after merge: {provider: "ollama", server: "http://localhost:11434", ...}
🧠 LLM Helper: Initializing RAGManager...
🔄 RAGManager: Starting initialization...
📁 RAGManager: Plugin data path: .../data.json
📂 RAGManager: Loading embeddings from persistent storage...
📊 RAGManager: Raw data check: {dataExists: true, hasEmbeddings: X, hasIndexedFiles: Y, ...}
🔄 RAGManager: Reconstructing vector store with X documents...
✅ RAGManager: Successfully loaded X embeddings from disk
📁 RAGManager: Y files were previously indexed
🗂️ RAGManager: Files: file1.md, file2.md, file3.md...
🕒 RAGManager: Last indexed: [date/time]
✅ RAGManager initialized with persistent storage
📊 Settings: Updated indexed files count to Y
```

### 2. **User Notifications**
You should see this notification appear:
```
📚 Loaded X embeddings from Y files (Z KB)
```

### 3. **Settings Panel**
When you open Settings → Local LLM Helper:
- **Indexed Files Count**: Should show the actual number (not 0)
- The count should change from "Loading..." to the real number
- **Run Diagnostics** button should show detailed info

## 🚨 **If Something is Wrong**

### Settings Reset to Default
If you see:
```
💾 LLM Helper: Raw saved data: null
```
This means your plugin settings aren't persisting. Possible causes:
1. Plugin was moved or reinstalled
2. Obsidian permissions issue
3. Plugin data directory changed

### No Embeddings Loaded
If you see:
```
🆕 RAGManager: No saved embeddings found, starting fresh
```
This is normal if:
1. First time using the plugin
2. You haven't indexed any notes yet
3. Settings changed (provider/model/server), causing a rebuild

### Settings Changed - Rebuild Required
If you see:
```
⚙️ RAGManager: Settings changed, embeddings will be rebuilt on next index
Current vs Saved: {current: {...}, saved: {...}}
```
This means you changed your embedding configuration, so embeddings need to be rebuilt.

## 🔧 **Quick Diagnostic Commands**

1. **Command Palette** (Ctrl/Cmd+P) → "RAG Storage Diagnostics"
2. **Settings** → Local LLM Helper → "Run Diagnostics" button
3. **Check Developer Console** for detailed logs

## 📁 **Data Storage Location**

Your data is now stored in separate files:
```
[Obsidian Vault]/.obsidian/plugins/obsidian-local-llm-helper/data.json      (Plugin settings)
[Obsidian Vault]/.obsidian/plugins/obsidian-local-llm-helper/embeddings.json (Embeddings data)
```

This separation prevents settings from being overwritten by embedding data.

## 🔧 **If You Had the Previous Bug**

If you were experiencing the re-indexing issue, you may need to:

1. **Clear corrupted data**: Use "RAG Storage Diagnostics" → look for any mixed data
2. **Reset plugin settings**: Go to Settings → Local LLM Helper and re-configure your provider/model
3. **Re-index once**: Run "Index Notes (BETA)" to create fresh embeddings in the new format

The bug was that embeddings were overwriting plugin settings in the same file. This is now fixed with separate storage files.