import { ApolloClient, InMemoryCache } from '@apollo/client';

export const apolloClient = new ApolloClient({
  uri: 'https://api.v3.aave.com/graphql',
  cache: new InMemoryCache(),
});
