import * as vscode from 'vscode';
import * as path from 'node:path';
import { createTest, findTests, getTestsDirectory } from './tests';

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
                void vscode.window.showErrorMessage(`TestRunner: ${message}`);
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
        output.clear();
        output.appendLine('Запуск программ будет добавлен на следующем этапе.');
        output.show(true);
    });
}
