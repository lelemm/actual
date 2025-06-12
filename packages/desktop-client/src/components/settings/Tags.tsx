import React, { useState } from 'react';
import { Form } from 'react-aria-components';
import { Trans } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { ColorPicker } from '@actual-app/components/color-picker';
import { FormError } from '@actual-app/components/form-error';
import {
  SvgAdd,
  SvgClose,
  SvgRefresh,
  SvgTrash,
} from '@actual-app/components/icons/v1';
import { Input } from '@actual-app/components/input';
import { styles } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { tokens } from '@actual-app/components/tokens';
import { View } from '@actual-app/components/view';
import { t } from 'i18next';

import { Setting } from './UI';

import { useSidebar } from '@desktop-client/components/sidebar/SidebarProvider';
import { purple700 } from '@desktop-client/style/palette';
import { useTagColor, useTagCSS, useTags } from '@desktop-client/style/tags';
import { FormField, FormLabel } from '../forms';
import { getNormalisedString } from 'loot-core/shared/normalisation';
import { Cell, InputCell, Row } from '../table';

type TagEditorProps = {
  tag: string;
  mode: 'trash' | 'edit';
};
const TagEditor = ({ tag, mode }: TagEditorProps) => {
  const getTagColor = useTagColor();
  const [tags, setTagsPref] = useTags();
  const getTagCSS = useTagCSS();

  const onTrashTag = (tag: string) => {
    const { [tag]: _, ...newTags } = tags;
    setTagsPref(newTags);
  };

  const formattedTag = <>#{tag === '*' ? t('Default') : tag}</>;

  if (mode === 'edit') {
    return (
      <ColorPicker
        value={getTagColor(tag)}
        onChange={color =>
          setTagsPref({ ...tags, [tag]: color.toString('hex') })
        }
      >
        <Button
          variant="bare"
          className={getTagCSS(tag)}
          style={{ width: 'fit-content' }}
        >
          {formattedTag}
        </Button>
      </ColorPicker>
    );
  } else {
    return (
      <Button
        variant="bare"
        className={getTagCSS(tag)}
        onPress={() => onTrashTag(tag)}
        style={{ width: 'fit-content' }}
      >
        {formattedTag}
        &nbsp;
        {tag !== '*' ? (
          <SvgClose width={10} height={10} />
        ) : (
          <SvgRefresh width={10} height={10} />
        )}
      </Button>
    );
  }
};

export function TagsSettings() {
  const sidebar = useSidebar();
  const [tags, setTagsPref] = useTags();
  const getTagCSS = useTagCSS();
  const [newTag, setNewTag] = useState('');
  const [newColor, setNewColor] = useState(purple700);
  const [errorMsg, setErrorMsg] = useState('');
  const [trashMode, setTrashMode] = useState(false);

  const onAddTagColor = () => {
    if (!newTag.trim()) {
      setErrorMsg(t('Tag name cannot be empty'));
      return;
    }

    if (!newColor.match(/^#(?:[0-9a-f]{3}){1,2}$/i)) {
      setErrorMsg(t('Invalid HEX color'));
      return;
    }

    setErrorMsg('');
    setTagsPref({ ...tags, [newTag.trim()]: newColor });
    setNewTag('');
  };

  const actionButtonStyle = {
    borderWidth: 0,
    backgroundColor: 'transparent',
    marginLeft: 'auto',
  };

  return (
    <Setting
      primaryAction={
        <View
          style={{
            flexDirection: 'column',
            gap: '1em',
            width: '100%',
            [`@media (min-width: ${
              sidebar.floating
                ? tokens.breakpoint_small
                : tokens.breakpoint_medium
            })`]: {
              flexDirection: 'column',
            },
          }}
        >
          {errorMsg && (
            <FormError
              style={{
                paddingTop: 5,
                marginLeft: styles.mobileEditingPadding,
                marginRight: styles.mobileEditingPadding,
                color: theme.errorText,
              }}
            >
              * {errorMsg}
            </FormError>
          )}
          <Form
            style={{
              display: 'flex',
              flexDirection: 'row',
              gap: '1em',
            }}
            onSubmit={e => {
              e.preventDefault();
              onAddTagColor();
            }}
          >
            <Input
              id="tag-field"
              placeholder="tag"
              value={newTag}
              onChangeValue={setNewTag}
            />
            <View
              style={{
                display: 'flex',
                flexDirection: 'row',
                gap: '8px',
              }}
            >
              <View style={{ margin: 'auto 0' }}>
                <ColorPicker
                  value={newColor}
                  onChange={color => setNewColor(color.toString('hex'))}
                >
                  <Button
                    variant="bare"
                    className={getTagCSS('', {
                      color: newColor,
                    })}
                  >
                    <Trans>Pick Color</Trans>
                  </Button>
                </ColorPicker>
              </View>
              <Button variant="bare" type="submit" style={actionButtonStyle}>
                <SvgAdd width={13} height={13} />
              </Button>
            </View>
            <Button
              variant="bare"
              type="button"
              style={actionButtonStyle}
              onPress={() => setTrashMode(!trashMode)}
            >
              <SvgTrash
                width={13}
                height={13}
                style={trashMode ? { color: theme.errorText } : {}}
              />
            </Button>
          </Form>
          <View
            style={{
              padding: '15px',
              border: '1px solid ' + theme.pillBorderDark,
              borderRadius: '4px',
              background: theme.tableBackground,
              display: 'flex',
              flexDirection: 'row',
              flexFlow: 'row wrap',
              gap: '8px',
            }}
          >
            <View style={{ display: 'inline' }}>
              <TagEditor tag="*" mode={trashMode ? 'trash' : 'edit'} />
            </View>

            {Object.keys(tags)
              .filter(tag => tag !== '*')
              .sort()
              .map(tag => (
                <View
                  key={tag}
                  style={{
                    display: 'flex',
                    flexDirection: 'row',
                  }}
                >
                  <TagEditor tag={tag} mode={trashMode ? 'trash' : 'edit'} />
                </View>
              ))}
          </View>
        </View>
      }
    >
      <Text>
        <Trans>
          <strong>Tags</strong> User defined tag colors.
        </Trans>
      </Text>
    </Setting>
  );
}

export function TagsPopover() {
  const sidebar = useSidebar();
  const [tags, setTagsPref] = useTags();
  const getTagCSS = useTagCSS();
  const [newTag, setNewTag] = useState('');
  const [newColor, setNewColor] = useState(purple700);
  const [errorMsg, setErrorMsg] = useState('');

  const onAddTagColor = () => {
    if (!newTag.trim()) {
      setErrorMsg(t('Tag name cannot be empty'));
      return;
    }

    if (!newColor.match(/^#(?:[0-9a-f]{3}){1,2}$/i)) {
      setErrorMsg(t('Invalid HEX color'));
      return;
    }

    setErrorMsg('');
    setTagsPref({ ...tags, [newTag.trim()]: newColor });
    setNewTag('');
  };

  return (
    <View
      style={{
        flexDirection: 'column',
        gap: '1em',
        width: '100%',
        [`@media (min-width: ${
          sidebar.floating ? tokens.breakpoint_small : tokens.breakpoint_medium
        })`]: {
          flexDirection: 'column',
        },
      }}
    >
      {errorMsg && (
        <FormError
          style={{
            paddingTop: 5,
            marginLeft: styles.mobileEditingPadding,
            marginRight: styles.mobileEditingPadding,
            color: theme.errorText,
          }}
        >
          * {errorMsg}
        </FormError>
      )}
      <Form
        style={{
          display: 'flex',
          flexDirection: 'column',
          padding: 20,
          width: '100%',
        }}
        onSubmit={e => {
          e.preventDefault();
          onAddTagColor();
        }}
      >
        <FormField style={{ flex: 1 }}>
          <FormLabel title={t('Tag')} htmlFor="tag-field" />
          <Input
            id="tag-field"
            placeholder="tag"
            value={newTag}
            onChangeValue={setNewTag}
          />
        </FormField>
        <FormField style={{ flex: 1, paddingTop: 10, paddingBottom: 10 }}>
          <FormLabel title={t('Description')} htmlFor="description-field" />
          <Input
            id="description-field"
            placeholder="tag description (optional)"
            value={newTag}
            onChangeValue={setNewTag}
          />
        </FormField>
        <View
          style={{
            display: 'flex',
            flexDirection: 'row',
            gap: '8px',
          }}
        >
          <View style={{ margin: 'auto 0' }}>
            <ColorPicker
              value={newColor}
              onChange={color => setNewColor(color.toString('hex'))}
            >
              <Button
                variant="bare"
                className={getTagCSS('', {
                  color: newColor,
                })}
              >
                <Trans>Pick Color</Trans>
              </Button>
            </ColorPicker>
          </View>
          <View
            style={{
              flexDirection: 'row',
              flexGrow: 1,
              justifyContent: 'flex-end',
            }}
          >
            <Button variant="primary" type="submit">
              Add tag
            </Button>
          </View>
        </View>
      </Form>
    </View>
  );
}

type TagsContentProps = {
  filter: string;
  trashMode: boolean;
};
export function TagsContent({ filter, trashMode }: TagsContentProps) {
  const sidebar = useSidebar();
  const [tags, setTagsPref] = useTags();
  const getTagCSS = useTagCSS();
  const [newTag, setNewTag] = useState('');
  const [newColor, setNewColor] = useState(purple700);
  const [errorMsg, setErrorMsg] = useState('');

  const onAddTagColor = () => {
    if (!newTag.trim()) {
      setErrorMsg(t('Tag name cannot be empty'));
      return;
    }

    if (!newColor.match(/^#(?:[0-9a-f]{3}){1,2}$/i)) {
      setErrorMsg(t('Invalid HEX color'));
      return;
    }

    setErrorMsg('');
    setTagsPref({ ...tags, [newTag.trim()]: newColor });
    setNewTag('');
  };

  return (
    <View
      style={{
        flexDirection: 'column',
        gap: '1em',
        width: '100%',
        [`@media (min-width: ${
          sidebar.floating ? tokens.breakpoint_small : tokens.breakpoint_medium
        })`]: {
          flexDirection: 'column',
        },
      }}
    >
      <View
        style={{
          border: '1px solid ' + theme.pillBorderDark,
          borderRadius: '4px',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Row
          height="auto"
          style={{
            fontSize: 13,
            backgroundColor: theme.tableBackground
          }}
          collapsed={true}
        >
          <Cell
            width={250}
            plain
            style={{ padding: '5px', paddingLeft: 5, alignItems: 'center' }}
          >
            <TagEditor tag="*" mode={trashMode ? 'trash' : 'edit'} />
          </Cell>
          <Cell
            width="flex"
            plain
            style={{ padding: '0 15px', paddingLeft: 5 }}
          >
            <View>Default tag style</View>
          </Cell>
        </Row>

        {Object.keys(tags)
          .filter(tag =>
            getNormalisedString(tag).includes(getNormalisedString(filter)),
          )
          .filter(tag => tag !== '*')
          .sort()
          .map(tag => (
            <Row
              height="auto"
              style={{
                fontSize: 13,
                backgroundColor: theme.tableBackground
              }}
              collapsed={true}
            >
              <Cell
                width={250}
                plain
                style={{
                  padding: '5px',
                  paddingLeft: 5,
                  alignItems: 'center',
                }}
              >
                <TagEditor tag={tag} mode={trashMode ? 'trash' : 'edit'} />
              </Cell>
              <InputCell
                width={350}
                name="notes"
                textAlign="flex"
                exposed={trashMode}
                value={'description'}
              ></InputCell>
              <Cell width="flex"></Cell>
            </Row>
          ))}
      </View>
    </View>
  );
}
