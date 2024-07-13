# Local LLM Helper - Obsidian Plugin

Seamlessly integrate your local LLM with Obsidian. Process large text chunks, transform content with AI, and maintain data privacy — all without leaving your notes.

## Core Features

#### Local LLM Integration:
* Compatible with OpenAI-like Servers: Works with local LLM servers like Ollama and LM Studio, providing privacy and offline flexibility.
* Model Selection: Users can specify the LLM model to use, tailoring the experience to their needs and hardware.
#### Text Processing Commands:
* Summarization: Condenses selected text while maintaining essential information and markdown formatting.
* Professional Tone Adjustment: Rewrites selected text to sound more formal and polished.
* Action Item Generation: Creates a structured list of actionable tasks from text.
* Custom Prompts: Allows users to define and execute their own prompts for specialized tasks.
* Prompt-as-Input: Uses the selected text directly as a prompt for creative text generation.

<img width="704" alt="image" src="https://github.com/user-attachments/assets/b55e305f-2f5c-4dab-9e67-251613065c67">

#### LLM Chat Interface:
* Interactive Chat Window: Engages in multi-turn conversations with the LLM for dynamic interaction.
* Conversation History: Keeps track of past messages within the same session.

<img width="577" alt="image" src="https://github.com/user-attachments/assets/b52b80db-b9a2-4986-8bb2-04aae264afcd">

#### Ribbon Menu and Status Bar:
* Ribbon Menu: Provides quick access to common commands and the chat interface.
* Status Bar: Displays the plugin's current status (ready or generating response).

<img width="191" alt="image" src="https://github.com/user-attachments/assets/953422d4-b15c-477d-8b28-f6b3f4f76b02">

#### Plugin Settings:
* Server Configuration: Easily set the server address, port, and model name.
* Custom Prompt: Define a personalized prompt for repeated use.
* Streaming Output: Toggle real-time, word-by-word output (experimental).
* Output Mode: Choose to replace or append the generated text to the selection.
* Personas: Select different personas to tailor the AI's response style.

<img width="838" alt="image" src="https://github.com/user-attachments/assets/8d5f582a-354d-4edd-aad4-e6c5fcbf228f">


## Release notes
v1.1.1 and v1.1.2
* Major update: LLM chat functionality that works with available personas
* New UI for chat interaction : typing indicators, response formatting, modern look for chat interface
* Streamlined personas related code
* CSS styling added for different parts of the plugin

v1.0.10
* Ollama support + support for all LLM servers that support OpenAI API /v1/chat/completions endpoint.
* Better prompts for available personas.

v1.0.9
* Added personas to choose from - available in Settings menu (raise issue for new persona needs)

v1.0.8
* Removed model name specification - it doesn't matter if you're using LMStudio.
* You can now choose whether to replace or append to the selected text.

v1.0.7
* Generate text button is updated to more meaningful text
* Command palette can now be accessed to use all the functionalities that were present before.

v1.0.6
* Custom prompt capability (enter your prompt in plugin Settings)
* Generate action items - new prompt addition
* Better status bar text updates

v1.0.5
* Streaming capabilities (enable in plugin Settings)
  
v1.0.4
* Summarize selected text in your Markdown notes.
* Rephrase to make selected text sound professional
* Generate text using selected text as prompt
* Access various LLM functionalities through a ribbon icon.

## Installation

Search for Local LLM Helper in Community plugins.
Install the plugin and enable it, to use with your vault.

## Usage

1. Select the text you want to process in your Markdown note (make sure to visit Settings page to make sure everything looks alright).
2. Click the plugin icon in the ribbon bar (brain icon) and choose the desired action.
3. Use LLM Chat with side interactions.

## Configuration

The plugin settings allow you to specify the server address, port, and LLM model name used for processing. 
The code currently supports all LLM servers that supports OpenAI API /v1/chat/completions endpoint.

1. Go to Settings > Obsidian LLM Helper.
2. Enter the details for your LLM server.
3. Choose the appropriate LLM model name from your server (if needed).
4. Select personas if needed.
5. Change replace/append based on preference.

**Note:** You'll need to set up and configure your own LLM server for this plugin to function.

## Development

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

## License

This plugin is distributed under the MIT license. See the LICENSE file for details.
