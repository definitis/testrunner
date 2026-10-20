import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { TestCase } from './tests';

interface ProcessResult {
    stdout: string;
    stderr: string;
    code: number | null;
    timedOut: boolean;
    problem?: string;
}

const OUTPUT_LIMIT = 1024 * 1024;

function errorMessage(error: unknown): string {
    if ((error as NodeJS.ErrnoException).code === 'UNKNOWN' && process.platform === 'win32') {
        return 'Не удалось запустить процесс (UNKNOWN). Проверьте журнал Code Integrity и политику запуска Windows.';
    }
    return error instanceof Error ? error.message : String(error);
}

function runProcess(command: string, args: string[], cwd: string, timeout: number,
    input = ''): Promise<ProcessResult> {
    return new Promise(resolve => {
        const child = spawn(command, args, {
            cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let bytes = 0;
        let timedOut = false;
        let problem: string | undefined;

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, timeout);

        function collect(chunk: Buffer, destination: Buffer[]): void {
            if (timedOut || problem) { return; }
            bytes += chunk.length;
            if (bytes > OUTPUT_LIMIT) {
                problem = 'Превышен лимит вывода процесса (1 МиБ).';
                child.kill('SIGKILL');
                return;
            }
            destination.push(chunk);
        }

        child.stdout.on('data', chunk => collect(chunk, stdout));
        child.stderr.on('data', chunk => collect(chunk, stderr));
        child.on('error', (error: NodeJS.ErrnoException) => {
            problem = command === 'g++' && error.code === 'ENOENT'
                ? 'Компилятор g++ не найден. Установите его и добавьте в PATH.'
                : errorMessage(error);
        });
        // Программа вправе завершиться, не прочитав весь вход.
        child.stdin.on('error', (error: NodeJS.ErrnoException) => {
            if (error.code !== 'EPIPE' && error.code !== 'ECONNRESET' && error.code !== 'EOF') {
                problem = errorMessage(error);
                child.kill('SIGKILL');
            }
        });
        child.on('close', code => {
            clearTimeout(timer);
            resolve({ stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8'), code, timedOut, problem });
        });
        child.stdin.end(input);
    });
}

export interface CompiledProgram {
    directory: string;
    executable: string;
}

export async function compile(source: string): Promise<CompiledProgram> {
    const absoluteSource = path.resolve(source);
    const directory = await mkdtemp(path.join(os.tmpdir(), 'testrunner-'));
    const executable = path.join(directory, process.platform === 'win32' ? 'program.exe' : 'program');
    try {
        const result = await runProcess('g++', ['-std=c++17', absoluteSource, '-o', executable],
            path.dirname(absoluteSource), 30000);
        if (result.problem) { throw new Error(result.problem); }
        if (result.timedOut) { throw new Error('Превышен лимит времени компиляции (30 секунд).'); }
        if (result.code !== 0) {
            throw new Error(`Ошибка компиляции (код ${result.code}):\n${result.stderr || result.stdout}`);
        }
        return { directory, executable };
    } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw new Error(errorMessage(error));
    }
}

export async function cleanup(program: CompiledProgram): Promise<void> {
    await rm(program.directory, { recursive: true, force: true });
}

export function normalizeOutput(output: string): string {
    return output.replace(/\r\n/g, '\n').trimEnd();
}

export interface TestResult {
    name: string;
    status: 'PASS' | 'FAIL' | 'ERROR' | 'TIMEOUT';
    expected: string;
    actual: string;
    details?: string;
}

export async function runTest(executable: string, test: TestCase, cwd: string): Promise<TestResult> {
    const result: TestResult = { name: test.name, status: 'ERROR', expected: '', actual: '' };
    try {
        const input = await readFile(test.inputPath, 'utf8');
        try {
            result.expected = await readFile(test.expectedPath, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                throw new Error(`Отсутствует ${path.basename(test.expectedPath)}.`);
            }
            throw error;
        }
        const processResult = await runProcess(executable, [], cwd, 3000, input);
        result.actual = processResult.stdout;
        if (processResult.timedOut) {
            result.status = 'TIMEOUT';
            result.details = 'Превышен лимит времени (3 секунды).';
        } else if (processResult.problem || processResult.code !== 0) {
            result.details = processResult.problem
                ?? `Ошибка выполнения (код ${processResult.code}):\n${processResult.stderr}`;
        } else {
            result.status = normalizeOutput(result.actual) === normalizeOutput(result.expected)
                ? 'PASS' : 'FAIL';
        }
    } catch (error) {
        result.details = errorMessage(error);
    }
    return result;
}
