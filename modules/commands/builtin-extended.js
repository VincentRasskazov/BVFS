import { makeDir, remove, writeFile, readFile } from '../vfs.js';
import { resolvePath } from '../path.js';
import { ENV } from '../env.js';
import { getFullHistory } from '../history.js';

export const extendedCommands = {
    mkdir: async (args, io) => {
        if (!args[0]) return io.stderr("mkdir: missing operand\n");
        try { await makeDir(resolvePath(ENV.PWD, args[0])); } 
        catch (e) { io.stderr(`mkdir: cannot create directory '${args[0]}': Error\n`); }
    },
    
    rm: async (args, io) => {
        if (!args[0]) return io.stderr("rm: missing operand\n");
        try { await remove(resolvePath(ENV.PWD, args[0])); } 
        catch (e) { io.stderr(`rm: cannot remove '${args[0]}': No such file or directory\n`); }
    },
    
    touch: async (args, io) => {
        if (!args[0]) return io.stderr("touch: missing file operand\n");
        try { await writeFile(resolvePath(ENV.PWD, args[0]), '', true); } 
        catch (e) { io.stderr(`touch: cannot touch '${args[0]}': Error\n`); }
    },
    
    grep: async (args, io) => {
        if (args.length < 1) return io.stderr("grep: missing pattern\n");
        const pattern = new RegExp(args[0]);
        
        // If grep receives piped input
        if (io.stdin) {
            const lines = io.stdin.split('\n');
            const matches = lines.filter(line => pattern.test(line));
            if (matches.length) io.stdout(matches.join('\n') + '\n');
            return;
        }

        // If grep reads from a file
        if (args.length < 2) return io.stderr("grep: missing file operand\n");
        try {
            const content = await readFile(resolvePath(ENV.PWD, args[1]));
            const lines = content.split('\n');
            const matches = lines.filter(line => pattern.test(line));
            if (matches.length) io.stdout(matches.join('\n') + '\n');
        } catch (e) { io.stderr(`grep: ${args[1]}: No such file or directory\n`); }
    },
    
    whoami: async (args, io) => io.stdout(ENV.USER + '\n'),
    
    date: async (args, io) => io.stdout(new Date().toString() + '\n'),
    
    history: async (args, io) => {
        const hist = getFullHistory();
        const out = hist.map((cmd, i) => `  ${i + 1}  ${cmd}`).join('\n');
        if (out) io.stdout(out + '\n');
    }
};
