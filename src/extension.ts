import * as vscode from 'vscode';
import * as path from 'node:path';
import { createTest, findTests, getTestsDirectory } from './tests';
import { cleanup, compile, runTest } from './runner';

function activeSource(): { document: vscode.TextDocument; directory: string } {
    const document = vscode.window.activeTextEditor?.document;
    if (!document || document.isUntitled || document.uri.scheme !== 'file'
        || path.extname(document.uri.fsPath).toLowerCase() !== '.cpp') {
        throw new Error('Откройте сохранённый файл .cpp.');
    }
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder) { throw new Error('Файл должен находиться внутри открытого проекта.'); }
    return { document, directory: getTestsDirectory(folder.uri.fsPath, document.uri.fsPath) };
}

async function openFile(file: string, column = vscode.ViewColumn.One): Promise<void> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document, { viewColumn: column });
}

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel('TestRunner');
    let running = false;
    context.subscriptions.push(output);

    function command(id: string, action: () => Promise<void>): void {
        context.subscriptions.push(vscode.commands.registerCommand(id, async () => {
            try {
                if (!vscode.workspace.isTrusted) {
                    throw new Error('Сначала разрешите доверие к рабочей области.');
                }
                await action();
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                output.appendLine(message);
                output.show(true);
                void vscode.window.showErrorMessage(`TestRunner: ${message.split('\n')[0]}`);
            }
        }));
    }

    command('testrunner.addTest', async () => {
        const test = await createTest(activeSource().directory);
        await openFile(test.expectedPath, vscode.ViewColumn.Beside);
        await openFile(test.inputPath);
    });

    command('testrunner.openTests', async () => {
        const tests = await findTests(activeSource().directory);
        if (!tests.length) { throw new Error('Тестов нет. Выполните TestRunner: Add Test.'); }
        const items = tests.flatMap(test => [test.inputPath, test.expectedPath])
            .map(file => ({ label: path.basename(file), file }));
        const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Открыть файл теста' });
        if (selected) { await openFile(selected.file); }
    });

    command('testrunner.runAllTests', async () => {
        if (running) {
            void vscode.window.showInformationMessage('TestRunner: тестирование уже выполняется.');
            return;
        }
        const { document, directory } = activeSource();
        running = true;
        try {
            output.clear();
            output.appendLine(`TestRunner — ${path.basename(document.uri.fsPath)}\n`);
            output.show(true);
            if (!await document.save()) { throw new Error('Не удалось сохранить исходный файл.'); }
            const tests = await findTests(directory);
            if (!tests.length) { throw new Error('Тестов нет. Выполните TestRunner: Add Test.'); }

            // Сохраняем только открытые изменённые файлы тестов текущей программы.
            const testPaths = new Set(tests.flatMap(test => [test.inputPath, test.expectedPath]));
            for (const open of vscode.workspace.textDocuments) {
                if (open.uri.scheme === 'file' && testPaths.has(open.uri.fsPath) && open.isDirty) {
                    if (!await open.save()) { throw new Error('Не удалось сохранить файл теста.'); }
                }
            }

            output.appendLine('Compiling...');
            const program = await compile(document.uri.fsPath);
            try {
                output.appendLine('Compilation successful!\n\nRunning tests...\n');
                let passed = 0;
                for (const test of tests) {
                    const result = await runTest(program.executable, test, path.dirname(document.uri.fsPath));
                    output.appendLine(`[${result.status}] ${result.name}`);
                    if (result.status === 'PASS') {
                        passed++;
                    } else if (result.status === 'FAIL') {
                        output.appendLine(`Expected:\n${result.expected}\nActual:\n${result.actual}\n`);
                    } else {
                        output.appendLine(`${result.details}\n`);
                    }
                }
                output.appendLine(`\n----------------------------\nResults: ${passed}/${tests.length} passed\n----------------------------`);
                void vscode.window.showInformationMessage(`TestRunner: ${passed}/${tests.length} tests passed`);
            } finally {
                await cleanup(program);
            }
        } finally {
            running = false;
        }
    });
}
