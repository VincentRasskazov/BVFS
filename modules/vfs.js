import { dirname, basename } from './path.js';

let opfsRoot;

export async function initVFS() {
    opfsRoot = await navigator.storage.getDirectory();
    const dirs = ['home', 'tmp', 'mnt', 'dev', 'proc', 'bin', 'etc'];
    for (const d of dirs) { await opfsRoot.getDirectoryHandle(d, { create: true }); }
    const home = await opfsRoot.getDirectoryHandle('home');
    await home.getDirectoryHandle('guest', { create: true });
}

async function getHandle(path, options = { create: false, isFile: false }) {
    if (path === '/') return opfsRoot;
    const parts = path.split('/').filter(Boolean);
    let curr = opfsRoot;
    
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const isLast = i === parts.length - 1;
        try {
            if (isLast && options.isFile) {
                return await curr.getFileHandle(part, { create: options.create });
            } else {
                curr = await curr.getDirectoryHandle(part, { create: (isLast ? options.create : false) });
            }
        } catch (e) { throw new Error(`No such file or directory: ${path}`); }
    }
    return curr;
}

export async function readDir(path) {
    const dirHandle = await getHandle(path);
    if (dirHandle.kind !== 'directory') throw new Error(`Not a directory: ${path}`);
    const entries = [];
    for await (const [name, handle] of dirHandle.entries()) {
        entries.push({ name, kind: handle.kind });
    }
    return entries;
}

export async function writeFile(path, content, append = false) {
    const fileHandle = await getHandle(path, { create: true, isFile: true });
    const writable = await fileHandle.createWritable({ keepExistingData: append });
    if (append) {
        const file = await fileHandle.getFile();
        await writable.seek(file.size);
    }
    await writable.write(content);
    await writable.close();
}

export async function readFile(path) {
    const fileHandle = await getHandle(path, { isFile: true });
    const file = await fileHandle.getFile();
    return await file.text();
}
