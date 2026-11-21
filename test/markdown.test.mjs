import test from 'node:test';
import assert from 'node:assert/strict';

import {
  countWords,
  renderBlocks,
  renderFrontMatter,
  renderInline,
  renderMarkdownDocument,
} from '../src/markdown.mjs';

const text = (v) => ({ t: 'text', v });

test('inline formatting covers emphasis, code, links and images', () => {
  assert.equal(
    renderInline([
      text('Use '),
      { t: 'strong', c: [text('this')] },
      text(' and '),
      { t: 'em', c: [text('that')] },
      text(', '),
      { t: 'code', v: 'npm i' },
      text('.'),
    ]),
    'Use **this** and *that*, `npm i`.',
  );

  assert.equal(
    renderInline([{ t: 'a', href: 'https://example.com/a', c: [text('link')] }]),
    '[link](https://example.com/a)',
  );
  assert.equal(
    renderInline([{ t: 'a', href: 'https://example.com/a', title: 'Tip', c: [text('link')] }]),
    '[link](https://example.com/a "Tip")',
  );
  assert.equal(
    renderInline([{ t: 'img', src: 'https://example.com/i.png', alt: 'Alt text' }]),
    '![Alt text](https://example.com/i.png)',
  );
  assert.equal(renderInline([text('5 * 3 and [brackets]')]), '5 \\* 3 and [brackets]');
  assert.equal(renderInline([{ t: 'br' }]), '  \n');
});

test('block rendering covers headings, paragraphs and code fences', () => {
  const markdown = renderBlocks([
    { b: 'h', level: 2, c: [text('Getting started')] },
    { b: 'p', c: [text('Install it.')] },
    { b: 'code', lang: 'js', v: 'const sms = await send();\nconsole.log(sms);' },
    { b: 'hr' },
  ]);

  assert.equal(
    markdown,
    [
      '## Getting started',
      'Install it.',
      '```js\nconst sms = await send();\nconsole.log(sms);\n```',
      '---',
    ].join('\n\n'),
  );

  // Content with triple backticks gets a longer fence.
  const fenced = renderBlocks([{ b: 'code', lang: '', v: '```\ninner\n```' }]);
  assert.match(fenced, /^````\n/);
});

test('lists render nested items with indentation', () => {
  const markdown = renderBlocks([
    {
      b: 'list',
      ordered: false,
      items: [
        [{ b: 'p', c: [text('one')] }],
        [
          { b: 'p', c: [text('two')] },
          { b: 'list', ordered: true, start: 1, items: [[{ b: 'p', c: [text('two.a')] }]] },
        ],
      ],
    },
  ]);

  assert.equal(markdown, ['- one', '- two', '  1. two.a'].join('\n'));
});

test('tables, quotes and figures render as markdown', () => {
  const table = renderBlocks([
    {
      b: 'table',
      rows: [
        [[text('Plan')], [text('Price')]],
        [[text('Starter')], [text('$9 | month')]],
      ],
    },
  ]);
  assert.equal(table, ['| Plan | Price |', '| --- | --- |', '| Starter | $9 \\| month |'].join('\n'));

  const quote = renderBlocks([{ b: 'quote', blocks: [{ b: 'p', c: [text('Quoted line')] }] }]);
  assert.equal(quote, '> Quoted line');

  const figure = renderBlocks([
    { b: 'img', src: 'https://example.com/a.png', alt: 'Chart', caption: [text('Figure 1: growth')] },
  ]);
  assert.equal(figure, '![Chart](https://example.com/a.png)\n\n*Figure 1: growth*');
});

test('front matter quotes values and keeps numbers raw', () => {
  const yaml = renderFrontMatter({ title: 'He said "hi"', words: 1234, author: '' });
  assert.equal(yaml, ['---', 'title: "He said \\"hi\\""', 'words: 1234', '---'].join('\n'));
});

test('inline wrappers preserve surrounding whitespace', () => {
  assert.equal(
    renderInline([text('world'), { t: 'a', href: 'https://example.com/x', c: [text(' software')] }, text('.')]),
    'world [software](https://example.com/x).',
  );
  assert.equal(
    renderInline([text('was'), { t: 'strong', c: [text(' really ')] }, text('good')]),
    'was **really** good',
  );
  assert.equal(
    renderInline([text('run'), { t: 'code', v: ' npm i ' }, text('now')]),
    'run `npm i` now',
  );
});

test('documents combine front matter, title and body', () => {
  const markdown = renderMarkdownDocument({
    meta: { title: 'Sending SMS', source: 'https://example.com/post', words: 4 },
    blocks: [{ b: 'p', c: [text('Hello world from SMS.')] }],
  });

  assert.match(markdown, /^---\ntitle: "Sending SMS"\nsource: "https:\/\/example\.com\/post"\nwords: 4\n---\n\n# Sending SMS\n\nHello world from SMS\.\n$/);
  assert.equal(countWords(markdown), 6); // "Sending SMS" + the four body words
});
