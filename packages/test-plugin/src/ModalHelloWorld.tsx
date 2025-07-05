import React, { useState, useEffect } from 'react';
import { 
  ActualPlugin, 
  Button, 
  ModalHeader, 
  View, 
  Stack, 
  Text, 
  Input, 
  theme
} from '@actual-app/plugins-core';

type DummyItem = {
  id: number;
  name: string;
  description: string;
  value: number;
  created_at: string;
};

type ModalHelloWorldProps = {
  text: string;
  context: Parameters<ActualPlugin['activate']>[0];
};

export function ModalHelloWorld({ text, context }: ModalHelloWorldProps) {
  const [items, setItems] = useState<DummyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [newItemName, setNewItemName] = useState('');
  const [newItemDescription, setNewItemDescription] = useState('');
  const [newItemValue, setNewItemValue] = useState('');


  // Fetch data from database using AQL
  const fetchItems = async () => {
    if (!context.db) {
      console.error('Database not available');
      setLoading(false);
      return;
    }

    try {
      const result = await context.db.aql(
        context.q('dummy_items').select('*').orderBy({ created_at: 'desc' }),
        { target: 'plugin' }
      );
      
      setItems(result.data || []);
      console.log('Items fetched with AQL:', result.data);
      console.log('Dependencies:', result.dependencies);
    } catch (error) {
      console.error('Error fetching items with AQL:', error);
    } finally {
      setLoading(false);
    }
  };

  // Add new item to database
  const addItem = async () => {
    if (!context.db || !newItemName.trim()) {
      return;
    }

    try {
      await context.db.runQuery(
        'INSERT INTO dummy_items (name, description, value) VALUES (?, ?, ?)',
        [newItemName.trim(), newItemDescription.trim(), parseFloat(newItemValue) || 0]
      );
      
      // Clear form
      setNewItemName('');
      setNewItemDescription('');
      setNewItemValue('');
      
      // Refresh data
      await fetchItems();
    } catch (error) {
      console.error('Error adding item:', error);
    }
  };

  useEffect(() => {
    fetchItems();
  }, []);

  return (
    <>
      <ModalHeader title={text} />
      <View style={{ padding: 20, minWidth: 500 }}>
        <View>
          <Text>
            This modal demonstrates database functionality. Below are items from the dummy_items table:
          </Text>

          {loading ? (
            <Text>Loading...</Text>
          ) : (
            <>
              <View style={{ marginTop: 10 }}>
                {items.length === 0 ? (
                  <Text>No items found</Text>
                ) : (
                  <View style={{ gap: 10 }}>
                    {items.map((item) => (
                      <View key={item.id} style={{ 
                        padding: 16, 
                        borderRadius: 4,
                        backgroundColor: theme.tableBackground,
                        gap: 10
                      }}>
                        <Text style={{ fontWeight: 'bold' }}>{item.name}</Text>
                        <Text>{item.description}</Text>
                        <Text style={{ color: '#666' }}>
                          Value: ${item.value.toFixed(2)} | Created: {new Date(item.created_at).toLocaleDateString()}
                        </Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>

              <View style={{ borderTop: '1px solid #ddd', paddingTop: 15 }}>
                <Text style={{ fontWeight: 'bold', marginBottom: 10 }}>Add New Item:</Text>
                <Stack spacing={2}>
                    <Input
                      value={newItemName}
                      onChange={(e) => setNewItemName(e.target.value)}
                      placeholder="Enter item name"
                    />
                  
                    <Input
                      value={newItemDescription}
                      onChange={(e) => setNewItemDescription(e.target.value)}
                      placeholder="Enter description"
                    />
                  
                    <Input
                      type="number"
                      step="0.01"
                      value={newItemValue}
                      onChange={(e) => setNewItemValue(e.target.value)}
                      placeholder="0.00"
                    />
                  
                  <View style={{ display: 'flex', gap: 10 }}>
                    <Button 
                      variant="primary" 
                      onPress={addItem}
                      isDisabled={!newItemName.trim()}
                    >
                      Add Item
                    </Button>

                    <Button variant="primary" onPress={() => context.popModal()}>
                      Close
                    </Button>
                  </View>
                </Stack>
              </View>
            </>
          )}
        </View>
      </View>
    </>
  );
}
  