## Local LLM Helper - Obsidian Plugin

This plugin integrates a local Large Language Model (LLM) service with Obsidian for summarizing and transforming text.

### Features

* Summarize selected text in your Markdown notes.
* Rephrase to make selected text sound professional
* Generate text using selected text as prompt
* Access various LLM functionalities through a ribbon icon.

### Installation

To be filled.

### Usage

1. Select the text you want to process in your Markdown note.
2. Click the plugin icon in the ribbon bar (brain icon) and choose the desired action:
    * Summarize
    * Make it Professional
    * Generate Text

### Configuration

The plugin settings allow you to specify the server address, port, and LLM model name used for processing. 
For v1, the LLM need to be running on LMStudio (lmstudio.ai). In future release, we will support other local LLM servers.

1. Go to Settings > Obsidian LLM Helper.
2. Enter the details for your LLM server.
3. Choose the appropriate LLM model name from your server (refer to your LLM Studio documentation).
4. Click "Save" to apply the changes.

**Note:** You'll need to set up and configure your own LLM server for this plugin to function.

### Development

Feel free to clone the repository and modify the code to suit your needs. The code utilizes the following Obsidian API elements:

* `App`
* `Editor`
* `MarkdownView`
* `Menu`
* `Notice`
* `Plugin`
* `PluginSettingTab`
* `Setting`
* `View`

### License

This plugin is distributed under the MIT license. See the LICENSE file for details.
