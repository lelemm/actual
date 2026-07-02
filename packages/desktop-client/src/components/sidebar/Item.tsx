// @ts-strict-ignore
import React from 'react';
import type {
  ComponentProps,
  ComponentType,
  CSSProperties,
  ReactNode,
  SVGProps,
} from 'react';

import { Block } from '@actual-app/components/block';
import { styles } from '@actual-app/components/styles';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { ItemContent } from './ItemContent';

const modernPalette = {
  panelRaised: '#1B3850',
  lineStrong: '#42617B',
  text: '#EAF2FA',
  textMuted: '#A9BAD0',
};

type ItemProps = {
  title: string;
  Icon:
    | ComponentType<SVGProps<SVGElement>>
    | ComponentType<SVGProps<SVGSVGElement>>;
  to?: string;
  children?: ReactNode;
  style?: CSSProperties;
  indent?: number;
  onClick?: ComponentProps<typeof ItemContent>['onClick'];
  forceHover?: boolean;
  forceActive?: boolean;
  modern?: boolean;
};

export function Item({
  children,
  Icon,
  title,
  style,
  to,
  onClick,
  indent = 0,
  forceHover = false,
  forceActive = false,
  modern = false,
}: ItemProps) {
  const hoverStyle = {
    backgroundColor: modern
      ? modernPalette.panelRaised
      : theme.sidebarItemBackgroundHover,
  };

  const content = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        height: 20,
      }}
    >
      <Icon width={15} height={15} />
      <Block style={{ marginLeft: 8 }}>{title}</Block>
      <View style={{ flex: 1 }} />
    </View>
  );

  return (
    <View style={{ flexShrink: 0, marginBottom: modern ? 3 : 0, ...style }}>
      <ItemContent
        style={{
          ...styles.mediumText,
          paddingTop: modern ? 7 : 9,
          paddingBottom: modern ? 7 : 9,
          paddingLeft: modern ? 10 + indent : 19 + indent,
          paddingRight: modern ? 10 : 10,
          textDecoration: 'none',
          color: modern ? modernPalette.textMuted : theme.sidebarItemText,
          borderRadius: modern ? 6 : 0,
          transition: modern
            ? 'background-color .15s, color .15s, box-shadow .15s'
            : undefined,
          ...(forceHover ? hoverStyle : {}),
          ':hover': hoverStyle,
        }}
        forceActive={forceActive}
        activeStyle={
          modern
            ? {
                backgroundColor: modernPalette.panelRaised,
                boxShadow: 'inset 0 0 0 1px ' + modernPalette.lineStrong,
                color: modernPalette.text,
              }
            : {
                borderLeft: '4px solid ' + theme.sidebarItemTextSelected,
                paddingLeft: 19 + indent - 4,
                color: theme.sidebarItemTextSelected,
              }
        }
        to={to}
        onClick={onClick}
      >
        {content}
      </ItemContent>
      {children ? <View style={{ marginTop: 5 }}>{children}</View> : null}
    </View>
  );
}
