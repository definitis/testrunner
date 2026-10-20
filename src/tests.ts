import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface TestCase {
    name: string;
    inputPath: string;
    expectedPath: string;
}

export function getTestsDirectory(root: string, source: string): string {
    const relative = path.relative(root, source);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)) {
        throw new Error('Исходник должен находиться внутри открытого проекта.');
    }
    const parsed = path.parse(relative);
    return path.join(root, '.testrunner', parsed.dir, parsed.name);
}

export async function findTests(directory: string): Promise<TestCase[]> {
    let entries;
    try {
        entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; }
        throw error;
    }
    return entries.filter(entry => entry.isFile() && /^test\d+\.in$/.test(entry.name))
        .map(entry => {
            const name = path.basename(entry.name, '.in');
            return { name, inputPath: path.join(directory, entry.name),
                expectedPath: path.join(directory, `${name}.out`) };
        })
        .sort((a, b) => Number(a.name.slice(4)) - Number(b.name.slice(4)));
}

export async function createTest(directory: string): Promise<TestCase> {
    await fs.mkdir(directory, { recursive: true });
    while (true) {
        const entries = await fs.readdir(directory);
        let maximum = 0;
        for (const entry of entries) {
            const match = /^test(\d+)\.(in|out)$/.exec(entry);
            if (match) { maximum = Math.max(maximum, Number(match[1])); }
        }
        if (!Number.isSafeInteger(maximum + 1)) {
            throw new Error('Слишком большой номер теста.');
        }
        const name = `test${maximum + 1}`;
        const inputPath = path.join(directory, `${name}.in`);
        const expectedPath = path.join(directory, `${name}.out`);
        try {
            await fs.writeFile(inputPath, '', { flag: 'wx' });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') { continue; }
            throw error;
        }
        try {
            await fs.writeFile(expectedPath, '', { flag: 'wx' });
        } catch (error) {
            // Если второй файл создать не удалось, убираем только наш новый вход.
            await fs.unlink(inputPath);
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') { continue; }
            throw error;
        }
        return { name, inputPath, expectedPath };
    }
}
