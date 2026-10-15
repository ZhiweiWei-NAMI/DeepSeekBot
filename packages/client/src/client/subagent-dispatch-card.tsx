import type { ReactElement } from 'react';
import * as stylex from '@stylexjs/stylex';

import { color, radius, space, text } from './ds/tokens.stylex.js';
import type { BotHarnessTranslate } from './locale.js';
import { parseSubagentDispatch } from './subagent-dispatch.js';

const styles = stylex.create({
  card: {
    display: 'grid',
    gap: space.x3,
    padding: space.x4,
    minWidth: 0,
    borderRadius: radius.md,
    backgroundColor: color.surface,
    color: color.fg,
    fontSize: text.bodySize,
    lineHeight: text.bodyLine,
    overflowWrap: 'anywhere',
  },
  heading: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    columnGap: space.x4,
    rowGap: space.x2,
    fontSize: text.metaSize,
    lineHeight: text.metaLine,
    color: color.muted,
  },
  summary: { margin: 0, fontWeight: text.strong },
  meta: {
    margin: 0,
    color: color.muted,
    fontSize: text.metaSize,
    lineHeight: text.metaLine,
  },
  queued: { color: color.muted },
  running: { color: color.accent },
  completed: { color: color.success },
  failed: { color: color.danger },
  declined: { color: color.warning },
});

export function SubagentDispatchCard({
  dispatch,
  t,
}: {
  dispatch: unknown;
  t: BotHarnessTranslate;
}): ReactElement | null {
  const item = parseSubagentDispatch(dispatch);
  if (item === undefined) return null;
  const route = item.resolvedRoute;
  return (
    <article
      {...stylex.props(styles.card)}
      aria-label={t('subagentDispatch.title')}
      data-dispatch-kind="subagent"
      data-dispatch-status={item.status}
    >
      <header {...stylex.props(styles.heading)}>
        <span>{t('subagentDispatch.title')}</span>
        <span {...stylex.props(styles[item.status])}>
          {t(`subagentDispatch.status.${item.status}`)}
        </span>
      </header>
      <p {...stylex.props(styles.summary)}>{item.description}</p>
      <p {...stylex.props(styles.meta)}>
        {t('subagentDispatch.model')}
        {' · '}
        {route === undefined
          ? t('subagentDispatch.modelUnavailable')
          : `${route.provider}/${route.model}`}
        {route?.reasoningEffort === undefined ? null : (
          <>
            {' · '}
            {t('subagentDispatch.effort')}
            {' · '}
            {route.reasoningEffort}
          </>
        )}
      </p>
      {item.reasonCode === undefined ? null : (
        <p {...stylex.props(styles.meta)}>{t(`subagentDispatch.reason.${item.reasonCode}`)}</p>
      )}
    </article>
  );
}
