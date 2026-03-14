import { initVFS, writeFile } from './vfs.js';
import { ENV } from './env.js';
import { parseCommand } from './parser.js';
import { commands as fsCommands } from './commands/builtin-fs.js';
import { resolvePath } from './path.js';

const registry = { ...fsCommands };
const ui = {
    output: document.getElementById('output'),
    input: document.getElementById('cmd-input'),
    prompt: document.getElementById('prompt')
};

async function initShell() {
    print("BVFS Kernel v1.0.0 initializing...\nMounting OPFS... ");
    try {
        await initVFS();
        print("Done.\n\n");
    } catch (e) { return print(`FAILED: ${e.message}\n`, true); }
    
    updatePrompt();
    ui.input.addEventListener('keydown', handleInput);
    // Keep focus on input
    document.addEventListener('click', () => ui.input.focus());
}

function updatePrompt() { ui.prompt.innerText = `${ENV.USER}@bvfs:${ENV.PWD}$ `; }

function print(text, isErr = false) {
    const span = document.createElement('span');
    if (isErr) span.className = 'out-err';
    span.innerText = text;
    ui.output.appendChild(span);
    ui.output.scrollTop = ui.output.scrollHeight;
}

async function handleInput(e) {
    if (e.key !== 'Enter') return;
    const cmdStr = ui.input.value.trim();
    ui.input.value = '';
    
    print(`${ui.prompt.innerText}${cmdStr}\n`);
    if (!cmdStr) return;

    await executePipeline(parseCommand(cmdStr));
    updatePrompt();
}

async function executePipeline(pipeline) {
    let previousStdout = null;
    for (let i = 0; i < pipeline.length; i++) {
        const cmdObj = pipeline[i];
        const cmdName = cmdObj.args.shift();
        
        if (!registry[cmdName]) { print(`bvfs: ${cmdName}: command not found\n`, true); break; }

        let currentStdout = '';
        const io = {
            stdin: previousStdout,
            stdout: (text) => { currentStdout += text; },
            stderr: (text) => { print(text, true); },
            clear: () => { ui.output.innerHTML = ''; }
        };

        try { await registry[cmdName](cmdObj.args, io); } 
        catch (err) { io.stderr(`Error: ${err.message}\n`); break; }

        if (cmdObj.redirectOut) {
            await writeFile(resolvePath(ENV.PWD, cmdObj.redirectOut), currentStdout, cmdObj.appendOut);
        } else if (i === pipeline.length - 1) {
            print(currentStdout);
        } else {
            previousStdout = currentStdout;
        }
    }
}

document.addEventListener('DOMContentLoaded', initShell);
