// Проверка файлов и настоящего g++ без тестовых библиотек и VS Code.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createTest, findTests, getTestsDirectory } = require('../out/tests');
const { compile, cleanup, runTest, normalizeOutput } = require('../out/runner');

async function main() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'testrunner smoke '));
    const source = path.join(root, 'задачи с пробелами', 'main.cpp');
    const directory = getTestsDirectory(root, source);
    let program;
    try {
        await fs.mkdir(path.dirname(source), { recursive: true });
        assert.equal(directory, path.join(root, '.testrunner', 'задачи с пробелами', 'main'));
        assert.notEqual(directory, getTestsDirectory(root, path.join(root, 'main.cpp')));
        assert.throws(() => getTestsDirectory(root, path.join(root, '..', 'outside.cpp')));
        assert.deepEqual(await findTests(directory), []);
        const first = await createTest(directory);
        await fs.writeFile(first.inputPath, '1 2 3');
        await fs.writeFile(first.expectedPath, '5');
        const second = await createTest(directory);
        assert.equal(second.name, 'test2');
        await fs.writeFile(path.join(directory, 'test9.out'), 'keep');
        assert.equal((await createTest(directory)).name, 'test10');
        const parallel = await Promise.all([createTest(directory), createTest(directory)]);
        assert.notEqual(parallel[0].name, parallel[1].name);
        assert.equal(await fs.readFile(first.inputPath, 'utf8'), '1 2 3');
        assert.equal(await fs.readFile(first.expectedPath, 'utf8'), '5');
        assert.equal(await fs.readFile(path.join(directory, 'test9.out'), 'utf8'), 'keep');
        await fs.mkdir(path.join(directory, 'test20.in'));
        await fs.unlink(second.expectedPath);
        assert.deepEqual((await findTests(directory)).map(test => test.name),
            ['test1', 'test2', 'test10', 'test11', 'test12']);
        console.log('OK: пути, нумерация, сохранение файлов, отсутствие перезаписи');

        assert.equal(normalizeOutput('a\r\nb \n\t'), 'a\nb');
        assert.notEqual(normalizeOutput('a \nb'), normalizeOutput('a\nb'));
        assert.notEqual(normalizeOutput(' a'), normalizeOutput('a'));
        console.log('OK: правила сравнения');

        const code = `#include <iostream>
#include <string>
int main() {
    int mode = 0; std::cin >> mode;
    if (mode == 1) { long long a, b; std::cin >> a >> b; std::cout << a + b << "\\n"; }
    if (mode == 2) { std::cout << 5; return 7; }
    if (mode == 3) { while (true) {} }
    if (mode == 4) { while (true) { std::cout << std::string(4096, 'x'); std::cerr << std::string(4096, 'y'); } }
    if (mode == 5) { std::cerr << "runtime failure"; return 2; }
    if (mode == 6) { std::cerr << "warning"; std::cout << 5; }
}`;
        await fs.writeFile(source, code);
        program = await compile(source);
        assert.deepEqual(await fs.readdir(path.dirname(source)), ['main.cpp']);

        async function check(label, input, expected, status, details) {
            await fs.writeFile(first.inputPath, input);
            await fs.writeFile(first.expectedPath, expected);
            const result = await runTest(program.executable, first, path.dirname(source));
            if (result.details?.includes('Code Integrity')) {
                throw new Error(`Проверка «${label}» заблокирована Windows: ${result.details}`);
            }
            assert.equal(result.status, status, JSON.stringify(result));
            if (details) { assert.match(result.details, details); }
            console.log(`OK: ${label}`);
            return result;
        }

        await check('PASS с CRLF и пробелами в конце', '1 2 3', '5\r\n \t', 'PASS');
        await check('FAIL', '1 2 3', '99', 'FAIL');
        const earlyExit = await check('ненулевой код и непрочитанный вход',
            '2\n' + '0'.repeat(2 * 1024 * 1024), '5', 'ERROR', /код 7/);
        assert.equal(earlyExit.actual, '5');
        await check('раннее закрытие stdin при нормальном завершении',
            '6\n' + '0'.repeat(2 * 1024 * 1024), '5', 'PASS');
        const timeoutStarted = Date.now();
        await check('TIMEOUT', '3', '', 'TIMEOUT');
        assert.ok(Date.now() - timeoutStarted < 7000, 'Процесс не остановлен вовремя');
        const overflow = await check('суммарный лимит stdout/stderr', '4', '', 'ERROR', /лимит вывода/);
        assert.ok(Buffer.byteLength(overflow.actual) <= 1024 * 1024);
        await check('диагностика stderr', '5', '', 'ERROR', /runtime failure/);
        await check('stderr не участвует в сравнении', '6', '5', 'PASS');
        await check('пустой вывод', '0', '\r\n \t', 'PASS');
        await fs.unlink(first.expectedPath);
        const missing = await runTest(program.executable, first, path.dirname(source));
        assert.equal(missing.status, 'ERROR');
        assert.match(missing.details, /Отсутствует test1.out/);
        console.log('OK: отсутствующий .out');

        const oldDirectory = program.directory;
        await cleanup(program);
        program = undefined;
        await assert.rejects(fs.access(oldDirectory));
        await fs.writeFile(source, code.replace('a + b', 'a + b + 1'));
        program = await compile(source);
        await check('повторная компиляция изменённого кода', '1 2 3', '6', 'PASS');

        await fs.writeFile(source, 'int main() { invalid_cpp }');
        await assert.rejects(compile(source), /Ошибка компиляции/);
        console.log('OK: ошибка компиляции');
        const savedPath = process.env.PATH;
        try {
            process.env.PATH = '';
            await assert.rejects(compile(source), /g\+\+ не найден/);
        } finally {
            if (savedPath === undefined) { delete process.env.PATH; }
            else { process.env.PATH = savedPath; }
        }
        console.log('OK: отсутствующий g++');
        console.log('Все проверки пройдены.');
    } finally {
        if (program) { await cleanup(program); }
        assert.ok(path.resolve(root).startsWith(path.join(os.tmpdir(), 'testrunner smoke ')));
        await fs.rm(root, { recursive: true, force: true });
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
