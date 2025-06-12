import React, { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';

import { Page } from '@desktop-client/components/Page';
import { TagsContent, TagsPopover } from '../settings/Tags';
import { View } from '@actual-app/components/view';
import { Text } from '@actual-app/components/text';
import { Search } from '../common/Search';
import { Dialog, DialogTrigger } from 'react-aria-components';
import { Button } from '@actual-app/components/button';
import { Popover } from '@actual-app/components/popover';
import { SvgAdd, SvgEditPencil, SvgTrash } from '@actual-app/components/icons/v1';
import { theme } from '@actual-app/components/theme';
import { Cell, TableHeader } from '../table';

export function ManageTagsPage() {
  const { t } = useTranslation();
  const [tagFilter, setTagFilter] = useState('');
  const [trashMode, setTrashMode] = useState(false);

  return (
    <Page header={t('Tags')}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          padding: '0 0 15px',
          flexShrink: 0,
        }}
      >
        <Text style={{ fontSize: '1.1rem' }}>
          <Trans>User defined tag colors.</Trans>
        </Text>
        <View style={{ flex: 1 }} />
        <Search
          placeholder={t('Filter tags...')}
          value={tagFilter}
          onChange={newValue => {
            setTagFilter(newValue);
          }}
        />
      </View>
      <View style={{ flexDirection: 'row', marginBottom: 10, gap: 10 }}>
        <DialogTrigger>
          <Button variant="bare">
            <SvgAdd width={10} height={10} style={{ marginRight: 3 }} />
            <Trans>Add Tag</Trans>
          </Button>

          <Popover style={{ width: 275 }}>
            <Dialog>
              <TagsPopover />
            </Dialog>
          </Popover>
        </DialogTrigger>
        <Button
          variant="bare"
          type="button"
          onPress={() => setTrashMode(!trashMode)}
          style={
            trashMode
              ? { color: theme.buttonPrimaryBackground }
              : { marginRight: 3 }
          }
        >
          <SvgEditPencil width={13} height={13} style={{ marginRight: 3 }} />
          <Trans>Toggle Edit</Trans>
        </Button>
      </View>
      <TableHeader style={{}}>
        <Cell value={t('Tag')} width={250} />
        <Cell value={t('Description')} width="flex" />
      </TableHeader>
      <TagsContent filter={tagFilter} trashMode={trashMode} />
    </Page>
  );
}
