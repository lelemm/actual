// @ts-strict-ignore
import React from 'react';
import type {
  ComponentProps,
  ComponentType,
  CSSProperties,
  SVGProps,
} from 'react';

import { Block } from '@actual-app/components/block';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { accountNameStyle } from './Account';
import { ItemContent } from './ItemContent';

const fontWeight = 600;
const modernPalette = {
  panelRaised: '#1B3850',
  lineStrong: '#42617B',
  text: '#EAF2FA',
  textMuted: '#A9BAD0',
};

type SecondaryItemProps = {
  title: string;
  to?: string;
  Icon?:
    | ComponentType<SVGProps<SVGElement>>
    | ComponentType<SVGProps<SVGSVGElement>>;
  style?: CSSProperties;
  onClick?: ComponentProps<typeof ItemContent>['onClick'];
  bold?: boolean;
  indent?: number;
  modern?: boolean;
};

export function SecondaryItem({
  Icon,
  title,
  style,
  to,
  onClick,
  bold,
  indent = 0,
  modern = false,
}: SecondaryItemProps) {
  const content = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        height: 16,
      }}
    >
      {Icon && <Icon width={12} height={12} />}
      <Block style={{ marginLeft: Icon ? 8 : 0, color: 'inherit' }}>
        {title}
      </Block>
    </View>
  );

  return (
    <View style={{ flexShrink: 0, marginBottom: modern ? 2 : 0, ...style }}>
      <ItemContent
        style={{
          ...accountNameStyle,
          color: modern ? modernPalette.textMuted : theme.sidebarItemText,
          paddingTop: modern ? 5 : accountNameStyle.paddingTop,
          paddingBottom: modern ? 5 : accountNameStyle.paddingBottom,
          paddingLeft: modern ? 10 + indent : 14 + indent,
          paddingRight: modern ? 10 : accountNameStyle.paddingRight,
          borderRadius: modern ? 6 : 0,
          fontWeight: bold ? fontWeight : null,
          ':hover': {
            backgroundColor: modern
              ? modernPalette.panelRaised
              : theme.sidebarItemBackgroundHover,
          },
        }}
        to={to}
        onClick={onClick}
        activeStyle={
          modern
            ? {
                backgroundColor: modernPalette.panelRaised,
                boxShadow: 'inset 0 0 0 1px ' + modernPalette.lineStrong,
                color: modernPalette.text,
                fontWeight: bold ? fontWeight : null,
              }
            : {
                borderLeft: '4px solid ' + theme.sidebarItemTextSelected,
                paddingLeft: 14 - 4 + indent,
                color: theme.sidebarItemTextSelected,
                fontWeight: bold ? fontWeight : null,
              }
        }
      >
        {content}
      </ItemContent>
    </View>
  );
}
