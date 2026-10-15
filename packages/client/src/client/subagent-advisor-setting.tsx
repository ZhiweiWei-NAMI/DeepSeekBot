import { useRef, useState, type ReactElement } from 'react';
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives';

import type { BridgeActions } from './actions.js';
import { Note } from './ds/note.js';
import { SettingsRow } from './ds/settings-row.js';
import type { BotHarnessTranslate } from './locale.js';
import { useMountedResource } from './mounted-resource.js';

export function SubagentAdvisorSetting({
  slug,
  actions,
  t,
}: {
  slug: string;
  actions: Pick<BridgeActions, 'subagentAdvisor' | 'setSubagentAdvisor'>;
  t: BotHarnessTranslate;
}): ReactElement {
  const [enabled, setEnabled] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const saving = useRef(false);
  const mount = useMountedResource<HTMLDivElement>(() => {
    const version = ++generation.current;
    setEnabled(undefined);
    setFailed(false);
    setBusy(false);
    saving.current = false;
    void actions.subagentAdvisor(slug).then(
      (value) => {
        if (generation.current === version) setEnabled(value);
      },
      () => {
        if (generation.current === version) setFailed(true);
      },
    );
    return () => {
      ++generation.current;
    };
  }, [actions, slug]);

  const toggle = async (value: boolean): Promise<void> => {
    if (enabled === undefined || saving.current) return;
    const version = generation.current;
    saving.current = true;
    setBusy(true);
    setFailed(false);
    try {
      const saved = await actions.setSubagentAdvisor(slug, value);
      if (generation.current === version) setEnabled(saved);
    } catch {
      if (generation.current === version) setFailed(true);
    } finally {
      if (generation.current === version) {
        saving.current = false;
        setBusy(false);
      }
    }
  };

  return (
    <SettingsRow
      rootRef={mount}
      title={t('subagentAdvisor.title')}
      description={t('subagentAdvisor.description')}
      data={{ 'data-subagent-advisor-setting': slug }}
      control={
        <Switch
          label={t('subagentAdvisor.title')}
          checked={enabled === true}
          disabled={enabled === undefined || busy}
          onChange={(value: boolean) => void toggle(value)}
        />
      }
    >
      <Note>{t('subagentAdvisor.notice')}</Note>
      {failed ? <Note tone="danger">{t('subagentAdvisor.error')}</Note> : null}
    </SettingsRow>
  );
}
