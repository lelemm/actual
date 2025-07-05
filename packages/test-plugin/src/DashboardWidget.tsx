import React, { useState, useEffect } from 'react';
import { 
  ActualPlugin, 
  Card, 
  View, 
  Text, 
  theme
} from '@actual-app/plugins-core';

type DummyItem = {
  id: number;
  name: string;
  description: string;
  value: number;
  created_at: string;
};

type DashboardWidgetProps = {
  context: Parameters<ActualPlugin['activate']>[0];
};

export function DummyItemsDashboardWidget({ context }: DashboardWidgetProps) {
  const [items, setItems] = useState<DummyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({
    totalItems: 0,
    totalValue: 0,
    averageValue: 0,
    latestItem: null as DummyItem | null
  });

  // Fetch data from database using AQL
  const fetchData = async () => {
    if (!context.db) {
      setLoading(false);
      return;
    }

    try {
      const result = await context.db.aql(
        context.q('dummy_items').select('*').orderBy({ created_at: 'desc' }),
        { target: 'plugin' }
      );
      
      const itemsData = (result.data as DummyItem[]) || [];
      setItems(itemsData);

      // Calculate statistics
      const totalItems = itemsData.length;
      const totalValue = itemsData.reduce((sum: number, item: DummyItem) => sum + item.value, 0);
      const averageValue = totalItems > 0 ? totalValue / totalItems : 0;
      const latestItem = itemsData.length > 0 ? itemsData[0] : null;

      setStats({
        totalItems,
        totalValue,
        averageValue,
        latestItem
      });
    } catch (error) {
      console.error('Error fetching dashboard data:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    
    // Refresh data every 30 seconds
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <View style={{ padding: 20, height: '100%' }}>
        <View style={{ height: '100%', justifyContent: 'center', alignItems: 'center' }}>
          <Text>Loading...</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={{ padding: 16, height: '100%' }}>
      <View style={{ height: '100%' }}>
        <View>
          <Text style={{ fontSize: 16, fontWeight: 'bold', marginBottom: 8 }}>
            Dummy Items Summary
          </Text>
          
          {/* Statistics Grid */}
          <View style={{ 
            display: 'grid', 
            gridTemplateColumns: '1fr 1fr', 
            gap: 12,
            marginBottom: 12
          }}>
            <View style={{ 
              padding: 12, 
              backgroundColor: theme.tableBackground, 
              borderRadius: 6,
              textAlign: 'center'
            }}>
              <Text style={{ fontSize: 20, fontWeight: 'bold', color: theme.pageTextPositive }}>
                {stats.totalItems}
              </Text>
              <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
                Total Items
              </Text>
            </View>
            
            <View style={{ 
              padding: 12, 
              backgroundColor: theme.tableBackground, 
              borderRadius: 6,
              textAlign: 'center'
            }}>
              <Text style={{ fontSize: 20, fontWeight: 'bold', color: theme.pageTextPositive }}>
                ${stats.totalValue.toFixed(2)}
              </Text>
              <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
                Total Value
              </Text>
            </View>
          </View>

          {/* Average Value */}
          {stats.totalItems > 0 && (
            <View style={{ 
              padding: 12, 
              backgroundColor: theme.tableBackground, 
              borderRadius: 6,
              textAlign: 'center'
            }}>
              <Text style={{ fontSize: 16, fontWeight: 'bold' }}>
                Average Value: ${stats.averageValue.toFixed(2)}
              </Text>
            </View>
          )}

          {/* Latest Item */}
          {stats.latestItem && (
            <View style={{ marginTop: 8 }}>
              <Text style={{ fontSize: 14, fontWeight: 'bold', marginBottom: 6 }}>
                Latest Item:
              </Text>
              <View style={{ 
                padding: 10, 
                backgroundColor: theme.tableBackground, 
                borderRadius: 4,
                borderLeft: `3px solid ${theme.pageTextLink}`
              }}>
                <Text style={{ fontSize: 13, fontWeight: 'bold' }}>
                  {stats.latestItem.name}
                </Text>
                <Text style={{ fontSize: 11, color: theme.pageTextSubdued }}>
                  ${stats.latestItem.value.toFixed(2)}
                </Text>
                <Text style={{ fontSize: 10, color: theme.pageTextSubdued }}>
                  {new Date(stats.latestItem.created_at).toLocaleDateString()}
                </Text>
              </View>
            </View>
          )}

          {/* Empty State */}
          {stats.totalItems === 0 && (
            <View style={{ 
              flex: 1, 
              justifyContent: 'center', 
              alignItems: 'center',
              textAlign: 'center'
            }}>
              <Text style={{ color: theme.pageTextSubdued, fontSize: 14 }}>
                No dummy items found.
              </Text>
              <Text style={{ color: theme.pageTextSubdued, fontSize: 12 }}>
                Use the plugin to add some items!
              </Text>
            </View>
          )}
        </View>
      </View>
    </View>
  );
} 