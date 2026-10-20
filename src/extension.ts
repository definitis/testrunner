import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel('TestRunner');
    context.subscriptions.push(output);
    context.subscriptions.push(vscode.commands.registerCommand('testrunner.runAllTests', () => {
        output.clear();
        output.appendLine('TestRunner готов к работе.');
        output.show(true);
    }));
}
