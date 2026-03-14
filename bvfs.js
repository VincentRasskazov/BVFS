// ==========================================
// 1. STATE & ENVIRONMENT
// ==========================================
export const ENV = { USER: 'guest', HOME: '/home/guest', PWD: '/home/guest' };
let opfsRoot;

// ==========================================
// 2. PATH & VFS (Origin Private File System)
// ==========================================
function resolvePath(target) {
    if (!target) return ENV.PWD;
    let base = target.startsWith('/') ? '/' : ENV.PWD;
    let parts = (base === '/' ? [] : base.split('/').filter(Boolean)).concat(target.split('/').filter(Boolean));
    let resolved = [];
    for (let p of parts) {
        if (p === '.') continue;
        if (p === '..') resolved.pop();
        else resolved.push(p);
    }
    return '/' + resolved.join('/');
}

async function initVFS() {
    opfsRoot = await navigator.storage.getDirectory();
    for (const d of ['home', 'tmp', 'bin']) await opfsRoot.getDirectoryHandle(d, { create: true });
    const home = await opfsRoot.getDirectoryHandle('home');
    await home.getDirectoryHandle('guest', { create: true });
}

async function getHandle(path, create = false, isFile = false) {
    if (path === '/') return opfsRoot;
    let curr = opfsRoot, parts = path.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
        let isLast = i === parts.length - 1;
        if (isLast && isFile) return await curr.getFileHandle(parts[i], { create });
        curr = await curr.getDirectoryHandle(parts[i], { create: (isLast ? create : false) });
    }
    return curr;
}

// ==========================================
// 3. PARSER & COMMANDS
// ==========================================
function parseCommand(input) {
    const tokens = input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    let pipeline = [], cmd = { args: [], redirectOut: null, append: false };
    
    for (let i = 0; i < tokens.length; i++) {
        let t = tokens[i].replace(/^["']|["']$/g, ''); // strip quotes
        if (t === '|') { pipeline.push(cmd); cmd = { args: [], redirectOut: null, append: false }; }
        else if (t === '>') cmd.redirectOut = tokens[++i];
        else if (t === '>>') { cmd.append = true; cmd.redirectOut = tokens[++i]; }
        else cmd.args.push(t);
    }
    pipeline.push(cmd);
    return pipeline;
}

const commands = {
    pwd: async (args, io) => io.stdout(ENV.PWD + '\n'),
    clear: async (args, io) => io.clear(),
    echo: async (args, io) => io.stdout(args.join(' ') + '\n'),
    cd: async (args, io) => {
        const target = resolvePath(args[0] || ENV.HOME);
        try { await getHandle(target); ENV.PWD = target; } 
        catch { io.stderr(`cd: ${args[0]}: No such directory\n`); }
    },
    ls: async (args, io) => {
        try {
            const dir = await getHandle(resolvePath(args[0] || '.'));
            let out = [];
            for await (const [name, handle] of dir.entries()) out.push(handle.kind === 'directory' ? `${name}/` : name);
            if (out.length) io.stdout(out.join('  ') + '\n');
        } catch { io.stderr(`ls: cannot access\n`); }
    },
    cat: async (args, io) => {
        if (!args.length && io.stdin) return io.stdout(io.stdin);
        for (const file of args) {
            try {
                const handle = await getHandle(resolvePath(file), false, true);
                io.stdout(await (await handle.getFile()).text() + '\n');
            } catch { io.stderr(`cat: ${file}: No such file\n`); }
        }
    }
};

// ==========================================
// 4. SHELL RUNTIME
// ==========================================
const ui = { out: document.getElementById('output'), in: document.getElementById('cmd-input'), prompt: document.getElementById('prompt') };

function print(text, isErr = false) {
    const span = document.createElement('span');
    if (isErr) span.className = 'out-err';
    span.innerText = text;
    ui.out.appendChild(span);
    ui.out.scrollTop = ui.out.scrollHeight;
}

async function execute(input) {
    print(`${ui.prompt.innerText}${input}\n`);
    if (!input.trim()) return;

    let prevOut = null;
    for (let cmdObj of parseCommand(input)) {
        let name = cmdObj.args.shift();
        if (!commands[name]) { print(`bvfs: ${name}: not found\n`, true); break; }

        let currOut = '';
        const io = { stdin: prevOut, stdout: (t) => currOut += t, stderr: (t) => print(t, true), clear: () => ui.out.innerHTML = '' };
        
        await commands[name](cmdObj.args, io);

        if (cmdObj.redirectOut) {
            const handle = await getHandle(resolvePath(cmdObj.redirectOut), true, true);
            const writable = await handle.createWritable({ keepExistingData: cmdObj.append });
            if (cmdObj.append) await writable.seek((await handle.getFile()).size);
            await writable.write(currOut);
            await writable.close();
        } else {
            prevOut = currOut;
        }
    }
    if (prevOut) print(prevOut);
}

window.onload = async () => {
    print("BVFS Micro-Kernel v2.0 initializing...\n");
    try { await initVFS(); print("OPFS Mounted.\n\n"); } catch (e) { print(`VFS Error: ${e.message}\n`, true); }
    
    ui.prompt.innerText = `${ENV.USER}@bvfs:${ENV.PWD}$ `;
    ui.in.addEventListener('keydown', async (e) => {
        if (e.key !== 'Enter') return;
        const val = ui.in.value; ui.in.value = '';
        await execute(val);
        ui.prompt.innerText = `${ENV.USER}@bvfs:${ENV.PWD}$ `;
    });
    document.addEventListener('click', () => ui.in.focus());
};
