// Both editor entry points consume these facts, so command behavior stays consistent.
function commandChain(editor, range) {
  const chain = editor.chain().focus()
  return range ? chain.deleteRange(range) : chain
}

export const EDITOR_COMMANDS = [
  {
    action: 'h1',
    title: 'Ueberschrift 1',
    keywords: ['h1', 'ueberschrift 1', 'ueberschrift', 'heading 1', 'heading1'],
    icon: 'H1',
    run: (editor, range) => commandChain(editor, range).toggleHeading({ level: 1 }).run(),
    isActive: editor => editor.isActive('heading', { level: 1 }),
  },
  {
    action: 'h2',
    title: 'Ueberschrift 2',
    keywords: ['h2', 'ueberschrift 2', 'heading 2', 'heading2'],
    icon: 'H2',
    run: (editor, range) => commandChain(editor, range).toggleHeading({ level: 2 }).run(),
    isActive: editor => editor.isActive('heading', { level: 2 }),
  },
  {
    action: 'bold',
    title: 'Fett',
    keywords: ['bold', 'fett'],
    icon: 'B',
    run: (editor, range) => commandChain(editor, range).toggleBold().run(),
    isActive: editor => editor.isActive('bold'),
  },
  {
    action: 'italic',
    title: 'Kursiv',
    keywords: ['italic', 'kursiv'],
    icon: 'I',
    run: (editor, range) => commandChain(editor, range).toggleItalic().run(),
    isActive: editor => editor.isActive('italic'),
  },
  {
    action: 'bullet',
    title: 'Aufzaehlung',
    keywords: ['ul', 'bullet', 'liste', 'list', 'aufzaehlung', 'aufzählung'],
    icon: '=',
    run: (editor, range) => commandChain(editor, range).toggleBulletList().run(),
    isActive: editor => editor.isActive('bulletList'),
  },
  {
    action: 'ordered',
    title: 'Nummerierte Liste',
    keywords: ['ol', 'nummeriert', 'numbered', 'ordered'],
    icon: '1.',
    run: (editor, range) => commandChain(editor, range).toggleOrderedList().run(),
    isActive: editor => editor.isActive('orderedList'),
  },
  {
    action: 'code',
    title: 'Code-Block',
    keywords: ['code', 'pre', 'block', 'codeblock', 'code-block'],
    icon: '<>',
    run: (editor, range) => commandChain(editor, range).toggleCodeBlock().run(),
    isActive: editor => editor.isActive('codeBlock'),
  },
  {
    action: 'image',
    title: 'Bild hochladen',
    keywords: ['image', 'bild', 'foto', 'photo', 'img', 'pic'],
    icon: '[+]',
    run: (editor, range, chooseImage) => {
      if (range) editor.chain().focus().deleteRange(range).run()
      chooseImage()
    },
    isActive: () => false,
  },
]

export function findEditorCommand(action) {
  return EDITOR_COMMANDS.find(command => command.action === action)
}

export function runEditorCommand(action, editor, { range, chooseImage } = {}) {
  return findEditorCommand(action)?.run(editor, range, chooseImage) ?? false
}

export function isEditorCommandActive(action, editor) {
  return findEditorCommand(action)?.isActive(editor) ?? false
}
