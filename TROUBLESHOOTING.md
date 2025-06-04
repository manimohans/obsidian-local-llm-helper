# Troubleshooting Guide

## Common Issues and Solutions

### 1. **Embedding Model Not Found (400 Bad Request)**

**Error**: `400 (Bad Request)` - `model "nomic-embed-text" not found, try pulling it first`

**This is the most common issue!**

**Solutions**:

#### For Ollama Users:
1. **Check what models are installed**:
   ```bash
   ollama list
   ```

2. **Install a compatible embedding model**:
   ```bash
   # Recommended embedding models:
   ollama pull mxbai-embed-large    # (Default in plugin)
   ollama pull nomic-embed-text     # Alternative option
   ollama pull all-minilm           # Smaller, faster option
   ```

3. **Update plugin settings** (IMPORTANT):
   - Go to Obsidian Settings → Community Plugins → Local LLM Helper → Settings
   - Set "Embedding Model Name" to match your installed model (e.g., `mxbai-embed-large`)
   - The plugin will automatically update when you save settings

4. **Verify model is working**:
   ```bash
   curl http://localhost:11434/api/embeddings \
     -d '{"model": "mxbai-embed-large", "prompt": "test"}'
   ```

### 2. **Connection Errors**

**Error**: `ECONNREFUSED` or `404 (Not Found)`

**Symptoms**: 
- Cannot connect to server
- "Server not found" errors

**Solutions**:

#### For Ollama Users:
1. **Start Ollama server**:
   ```bash
   ollama serve
   ```

2. **Verify server is running**:
   ```bash
   curl http://localhost:11434/api/tags
   ```

3. **Check plugin settings**: 
   - Provider Type = "Ollama"
   - Server Address = `http://localhost:11434`

#### For LM Studio Users:
1. **Start LM Studio server**:
   - Open LM Studio
   - Go to "Local Server" tab
   - Click "Start Server"

2. **Load an embedding model**:
   - Download an embedding model (e.g., `nomic-ai/nomic-embed-text-v1.5-GGUF`)
   - Load it in the server tab

3. **Verify server address**: 
   - Default: `http://localhost:1234`
   - Check plugin settings: Provider Type = "OpenAI" 

4. **Test LM Studio API**:
   ```bash
   curl http://localhost:1234/v1/models
   ```

### 2. **Model Not Found Errors**

**Error**: `model "nomic-embed-text" not found`

**Solutions**:

#### For Ollama:
```bash
ollama pull nomic-embed-text
ollama list  # Verify model is installed
```

#### For LM Studio:
- Download compatible embedding models from HuggingFace
- Popular options: `nomic-ai/nomic-embed-text-v1.5-GGUF`

### 3. **Plugin Settings Configuration**

**Recommended Settings**:

#### Ollama Setup:
- **Provider Type**: Ollama
- **Server Address**: `http://localhost:11434`
- **Embedding Model**: `mxbai-embed-large` (or any installed embedding model)
- **LLM Model**: `llama3` (or any installed chat model)

#### LM Studio Setup:
- **Provider Type**: OpenAI
- **Server Address**: `http://localhost:1234`
- **Embedding Model**: Name of loaded embedding model
- **LLM Model**: Name of loaded chat model
- **OpenAI API Key**: `lm-studio` (can be anything)

### 4. **Performance Issues**

**Symptoms**: Slow indexing or timeouts

**Solutions**:
1. **Reduce chunk size** in code (default: 1000 chars)
2. **Index smaller batches** of files
3. **Check system resources** (RAM/CPU usage)
4. **Use faster embedding models**

### 5. **Persistent Storage Notice**

**Good News**: This plugin now uses **persistent storage** for embeddings!

**What this means**:
- Embeddings are saved to your Obsidian data directory
- When you restart Obsidian, embeddings are automatically loaded
- No need to re-index your notes after restart
- Embeddings will only be rebuilt if you change provider, model, or server settings

**This provides much better performance** after the initial indexing!

### 6. **Verification Steps**

**Test Your Setup**:

1. **Run Storage Diagnostics**:
   - Use Command Palette (Ctrl/Cmd+P) → "RAG Storage Diagnostics"
   - OR go to Settings → Local LLM Helper → "Run Diagnostics" button
   - Check console for detailed storage information

2. **Check console logs** (Developer Tools > Console)
   - Look for messages starting with 🔌, 📂, 🧠, ✅, or ❌
   - Persistent storage messages will show embedding counts and file lists

3. **Verify server is responding**:
   ```bash
   # For Ollama
   curl http://localhost:11434/api/tags
   
   # For LM Studio  
   curl http://localhost:1234/v1/models
   ```

4. **Test embedding API**:
   ```bash
   # For Ollama
   curl http://localhost:11434/api/embeddings \
     -d '{"model": "nomic-embed-text", "prompt": "test"}'
   
   # For LM Studio
   curl http://localhost:1234/v1/embeddings \
     -H "Content-Type: application/json" \
     -d '{"model": "nomic-embed-text", "input": "test"}'
   ```

### 7. **Getting Help**

If you're still having issues:

1. **Check console logs** for detailed error messages
2. **Verify server logs** (Ollama/LM Studio console output)
3. **Test API endpoints** manually with curl
4. **Report issues** with full error logs and configuration details

## Quick Reference

| Provider | Default Port | Default Model | API Endpoint |
|----------|--------------|---------------|--------------|
| Ollama | 11434 | nomic-embed-text | `/api/embeddings` |
| LM Studio | 1234 | (varies) | `/v1/embeddings` |

## Common Commands

```bash
# Ollama
ollama serve
ollama pull nomic-embed-text
ollama list

# Test connections
curl http://localhost:11434/api/tags      # Ollama
curl http://localhost:1234/v1/models     # LM Studio
```