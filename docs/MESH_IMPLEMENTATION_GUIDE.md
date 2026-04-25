# Mesh Network Implementation - IEEE Peer-to-Peer Optimization

## 🌐 MESH ARCHITECTURE

### Vision: Distributed PC Network
```
User's Home                    Friend's Office                  Coworker's Studio
┌──────────────┐              ┌──────────────┐                ┌──────────────┐
│ PC-1 (Linux) │              │ PC-2 (macOS) │                │ PC-3 (Windows)
│ 2 cores, 8GB │              │ 4 cores, 16GB │              │ 8 cores, 32GB │
└──────────────┘              └──────────────┘                └──────────────┘
       │                              │                              │
       └──────────────────────────────┼──────────────────────────────┘
                                      │
                          ┌───────────┴───────────┐
                          │   WatchTower Network  │
                          │   "Production Mesh"   │
                          └───────────┬───────────┘
                                      │
                          ┌───────────┴───────────┐
                          │ Load Balancer         │
                          │ (Caddy / Nginx)       │
                          └───────────┬───────────┘
                                      │
                         ┌────────────┴────────────┐
                         │  Route to fastest node  │
                         │  based on geography &   │
                         │  latency measurements   │
                         └────────────┬────────────┘
                                      │
                              🌍 Internet
```

### Key Concept: Peer-to-Peer Optimization
Instead of centralizing traffic through one node, the mesh learns the network topology and routes deployments through the fastest paths - inspired by IEEE peer-to-peer transfer research.

---

## 🔧 IMPLEMENTATION PHASES

### Phase 1: Basic Mesh UI & Management

#### UI Components

```
Path: /networks

┌─────────────────────────────────────────────────────────┐
│ 📡 Node Networks                                        │
├─────────────────────────────────────────────────────────┤
│ [+ Create Network]                                      │
│                                                         │
│ ┌──────────────────────────────────────────────────┐   │
│ │ Production Mesh                                  │   │
│ │ Status: ✓ All nodes healthy                      │   │
│ │ Nodes: 3/3                                       │   │
│ │ Avg Latency: 15ms                                │   │
│ │ Last deployment sync: 2 min ago                  │   │
│ │ [View Details] [Edit] [Delete]                   │   │
│ └──────────────────────────────────────────────────┘   │
│                                                         │
│ ┌──────────────────────────────────────────────────┐   │
│ │ Staging Network                                  │   │
│ │ Status: ⚠ 1 node unreachable                     │   │
│ │ Nodes: 2/3                                       │   │
│ │ [Fix Issue]                                      │   │
│ └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

#### Network Detail Page

```
Path: /networks/{network_id}

┌─────────────────────────────────────────────────────────┐
│ Production Mesh                                         │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ Network Settings:                                       │
│ ├─ Load Balance: [✓ Enabled]                           │
│ ├─ Health Check: Every [300] seconds                   │
│ ├─ Strategy:                                           │
│ │  [o] Round Robin (distribute evenly)                │
│ │  [ ] Geographic (closest node)                      │
│ │  [ ] Throughput (fastest node)                      │
│ │  [ ] Cost (cheapest available)                      │
│ └─ [Save Settings]                                    │
│                                                         │
│ Nodes in Network:                                      │
│ ┌───────────────────────────────────────────────────┐ │
│ │ PC-1 (Linux) - ankur-home-pc                     │ │
│ │ Status: ✓ Healthy                                │ │
│ │ CPU: 2 cores | RAM: 8GB                          │ │
│ │ Latency: 2ms | Weight: 33%                       │ │
│ │ [Edit Weight] [Remove]                           │ │
│ └───────────────────────────────────────────────────┘ │
│ ┌───────────────────────────────────────────────────┐ │
│ │ PC-2 (macOS) - emily-macbook                     │ │
│ │ Status: ✓ Healthy                                │ │
│ │ CPU: 4 cores | RAM: 16GB                         │ │
│ │ Latency: 22ms | Weight: 50%                      │ │
│ │ [Edit Weight] [Remove]                           │ │
│ └───────────────────────────────────────────────────┘ │
│ ┌───────────────────────────────────────────────────┐ │
│ │ PC-3 (Windows) - coworker-studio                 │ │
│ │ Status: ✓ Healthy                                │ │
│ │ CPU: 8 cores | RAM: 32GB                         │ │
│ │ Latency: 45ms | Weight: 17%                      │ │
│ │ [Edit Weight] [Remove]                           │ │
│ └───────────────────────────────────────────────────┘ │
│                                                         │
│ [+ Add Node to Network]                                │
│                                                         │
│ Network Topology Graph:                                │
│ (SVG showing nodes + latencies + traffic flow)         │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## 🧠 IEEE Peer-to-Peer Optimization Algorithm

### Phase 2: Mesh Orchestration Service

```python
# watchtower/mesh/orchestrator.py (NEW)

import asyncio
from typing import Dict, List, Tuple
import numpy as np

class MeshOrchestrator:
    """
    IEEE-Inspired Peer-to-Peer Transfer Optimization
    
    Concepts from:
    - "Optimizing Content Distribution in Peer-to-Peer Networks"
    - "Throughput-Aware Mesh Routing"
    
    Implements:
    1. Network topology discovery
    2. Latency measurement between node pairs
    3. Bandwidth estimation
    4. Optimal routing algorithm (shortest + fastest path)
    5. Continuous adaptation as network changes
    """
    
    def __init__(self, db: Session):
        self.db = db
        self.latency_matrix: Dict[Tuple[UUID, UUID], float] = {}
        self.bandwidth_matrix: Dict[Tuple[UUID, UUID], float] = {}
    
    async def discover_topology(self, network_id: UUID) -> Dict:
        """
        Find all node pairs in network
        Build adjacency graph
        
        Returns:
        {
            "nodes": [node_1, node_2, node_3],
            "edges": [
                {"from": node_1, "to": node_2, "latency": 15ms, "bandwidth": 100Mbps},
                ...
            ]
        }
        """
        network = self.db.query(NodeNetwork)\
            .filter(NodeNetwork.id == network_id)\
            .first()
        
        if not network:
            return {}
        
        nodes = network.nodes
        edges = []
        
        # Measure latency/bandwidth between all node pairs
        for i, node_a in enumerate(nodes):
            for node_b in nodes[i+1:]:
                latency = await self.measure_latency(node_a, node_b)
                bandwidth = await self.measure_bandwidth(node_a, node_b)
                
                edges.append({
                    "from": node_a.id,
                    "to": node_b.id,
                    "latency_ms": latency,
                    "bandwidth_mbps": bandwidth,
                    "score": self.compute_edge_score(latency, bandwidth)
                })
        
        return {
            "nodes": [n.id for n in nodes],
            "edges": edges
        }
    
    async def measure_latency(self, node_a: OrgNode, node_b: OrgNode) -> float:
        """
        Measure round-trip latency between nodes using ping/ICMP
        
        Returns: latency in milliseconds
        """
        import subprocess
        
        try:
            # SSH into node_a, ping node_b
            cmd = f"ping -c 1 -W 2 {node_b.host} | grep 'time=' | grep -oE '[0-9.]+ ms' | awk '{{print $1}}'"
            
            result = subprocess.run(
                ["ssh", f"{node_a.user}@{node_a.host}", cmd],
                capture_output=True,
                timeout=5,
                check=False
            )
            
            if result.returncode == 0:
                latency_str = result.stdout.decode().strip()
                return float(latency_str)
            else:
                return float('inf')  # Node unreachable
                
        except Exception as e:
            logger.warning(f"Failed to measure latency {node_a.host} → {node_b.host}: {e}")
            return float('inf')
    
    async def measure_bandwidth(self, node_a: OrgNode, node_b: OrgNode) -> float:
        """
        Measure throughput between nodes using iperf3
        
        Returns: bandwidth in Mbps
        """
        try:
            # This would require iperf3 installed on nodes
            # For now, estimate based on latency (simpler fallback)
            latency = await self.measure_latency(node_a, node_b)
            
            if latency == float('inf'):
                return 0
            
            # Rough estimate: lower latency = better bandwidth potential
            # Real implementation would use iperf3
            estimated_bw = 1000 / (1 + latency)  # Mbps
            return estimated_bw
            
        except Exception as e:
            logger.warning(f"Failed to measure bandwidth: {e}")
            return 0
    
    def compute_edge_score(self, latency: float, bandwidth: float) -> float:
        """
        IEEE-inspired edge scoring function
        Lower score = better route
        
        score = (latency_weight * latency) / (bandwidth_weight * bandwidth)
        """
        if latency == float('inf') or bandwidth == 0:
            return float('inf')
        
        # Weights can be tuned based on deployment type
        latency_weight = 1.0
        bandwidth_weight = 0.5
        
        return (latency_weight * latency) / (bandwidth_weight * bandwidth)
    
    def find_optimal_routing_tree(self, topology: Dict) -> Dict:
        """
        Given network topology, find optimal routing tree for deployment sync
        
        Uses: Prim's algorithm variant optimized for peer-to-peer transfer
        
        Returns:
        {
            "source": node_1_id,
            "tree": {
                node_1_id: [node_2_id, node_3_id],
                node_2_id: [node_4_id],
                ...
            },
            "total_latency": 45ms
        }
        """
        if not topology.get("edges"):
            return {}
        
        nodes = topology["nodes"]
        edges = topology["edges"]
        
        # Convert to adjacency list with weights (scores)
        graph = {node: [] for node in nodes}
        for edge in edges:
            graph[edge["from"]].append({
                "to": edge["to"],
                "score": edge["score"],
                "latency": edge["latency_ms"]
            })
            graph[edge["to"]].append({
                "to": edge["from"],
                "score": edge["score"],
                "latency": edge["latency_ms"]
            })
        
        # Prim's algorithm to find minimum spanning tree
        source = nodes[0]  # Start from first node
        mst = {node: [] for node in nodes}
        visited = {source}
        edges_to_consider = []
        
        # Initialize with source's neighbors
        for neighbor in graph[source]:
            edges_to_consider.append({
                "from": source,
                "to": neighbor["to"],
                "score": neighbor["score"]
            })
        
        # Build minimum spanning tree
        while edges_to_consider and len(visited) < len(nodes):
            # Find lowest-score edge to unvisited node
            edges_to_consider.sort(key=lambda e: e["score"])
            
            for edge in edges_to_consider[:]:
                if edge["to"] not in visited:
                    from_node = edge["from"]
                    to_node = edge["to"]
                    
                    mst[from_node].append(to_node)
                    visited.add(to_node)
                    
                    # Add to_node's neighbors to consider
                    for neighbor in graph[to_node]:
                        if neighbor["to"] not in visited:
                            edges_to_consider.append({
                                "from": to_node,
                                "to": neighbor["to"],
                                "score": neighbor["score"]
                            })
                    
                    edges_to_consider.remove(edge)
                    break
        
        return {
            "source": source,
            "tree": mst,
            "num_nodes_connected": len(visited)
        }
    
    async def optimize_mesh_routing(self, network_id: UUID):
        """
        Continuous optimization: measure topology every 60 seconds
        Recompute optimal routing if significant changes detected
        """
        while True:
            try:
                topology = await self.discover_topology(network_id)
                routing_tree = self.find_optimal_routing_tree(topology)
                
                # Store in cache for deployment sync to use
                await self.store_routing_tree(network_id, routing_tree)
                
                # Log metrics
                logger.info(f"Network {network_id} topology optimized: {topology}")
                
            except Exception as e:
                logger.exception(f"Mesh optimization failed: {e}")
            
            # Re-measure every 60 seconds
            await asyncio.sleep(60)
    
    async def store_routing_tree(self, network_id: UUID, tree: Dict):
        """Cache routing tree for fast deployment sync"""
        # Could use Redis or in-memory cache
        self.routing_trees[network_id] = tree
```

### Phase 3: Deployment Sync via Mesh

```python
# watchtower/mesh/deployment_sync.py (NEW)

class MeshDeploymentSync:
    """
    Deploy to primary node first, then use optimized routing
    to sync to other nodes in parallel along fastest paths
    """
    
    def __init__(self, orchestrator: MeshOrchestrator):
        self.orchestrator = orchestrator
    
    async def deploy_to_mesh(
        self,
        deployment_id: UUID,
        network_id: UUID,
        artifact_path: str
    ):
        """
        Deployment workflow:
        1. Deploy to primary node (fastest/most reliable)
        2. Get optimized routing tree from orchestrator
        3. Sync artifact to all nodes in parallel using tree
        4. Verify all nodes received deployment
        5. Mark deployment complete when all synced
        """
        
        # Get network and nodes
        network = self.db.query(NodeNetwork).filter(
            NodeNetwork.id == network_id
        ).first()
        
        if not network or not network.nodes:
            raise ValueError("Network has no nodes")
        
        primary_node = max(network.nodes, key=lambda n: n.priority)
        
        # Step 1: Deploy to primary
        logger.info(f"Deploying {deployment_id} to primary node {primary_node.id}")
        await self.deploy_to_node(primary_node, artifact_path)
        
        # Step 2: Get optimized routing tree
        routing_tree = self.orchestrator.routing_trees.get(network_id)
        if not routing_tree:
            # Compute it if not cached
            topology = await self.orchestrator.discover_topology(network_id)
            routing_tree = self.orchestrator.find_optimal_routing_tree(topology)
        
        # Step 3: Sync to all other nodes in parallel
        secondary_nodes = [n for n in network.nodes if n.id != primary_node.id]
        
        # Build sync tasks using routing tree
        sync_tasks = []
        for node in secondary_nodes:
            # Use routing tree to potentially sync via another node (P2P transfer)
            sync_task = self.sync_deployment_optimal_path(
                deployment_id,
                node,
                primary_node,
                artifact_path,
                routing_tree
            )
            sync_tasks.append(sync_task)
        
        # Execute all syncs in parallel
        results = await asyncio.gather(*sync_tasks, return_exceptions=True)
        
        # Check results
        failed_nodes = []
        for node, result in zip(secondary_nodes, results):
            if isinstance(result, Exception):
                logger.error(f"Failed to sync to {node.id}: {result}")
                failed_nodes.append(node.id)
        
        if failed_nodes:
            logger.warning(f"Deployment {deployment_id} partially synced. Failed: {failed_nodes}")
            # Could implement retry logic here
        else:
            logger.info(f"Deployment {deployment_id} successfully synced to all nodes")
        
        # Mark deployment as synced
        deployment = self.db.query(Deployment).filter(
            Deployment.id == deployment_id
        ).first()
        if deployment:
            deployment.status = "synced_to_mesh"
            self.db.commit()
    
    async def sync_deployment_optimal_path(
        self,
        deployment_id: UUID,
        target_node: OrgNode,
        primary_node: OrgNode,
        artifact_path: str,
        routing_tree: Dict
    ):
        """
        Sync deployment using optimal path from routing tree
        
        Two strategies:
        1. Direct P2P: Download directly from primary → target
        2. Hop: Download from closer intermediate node (if faster)
        """
        
        # Check if there's an optimal path via another node
        optimal_source = primary_node
        
        # Get routing tree
        tree = routing_tree.get("tree", {})
        if primary_node.id in tree:
            # Check intermediate nodes
            intermediates = tree[primary_node.id]
            if intermediates:
                # Pick closest intermediate that's already synced
                # (This would require tracking sync status)
                # For now, just use primary as source
                pass
        
        # Direct P2P transfer: target_node downloads from optimal_source
        logger.info(f"Syncing {artifact_path} to {target_node.id} via {optimal_source.id}")
        
        # SSH into target node, download from optimal_source
        # rsync or direct HTTP download
        cmd = f"rsync -avz {optimal_source.user}@{optimal_source.host}:{artifact_path} {artifact_path}"
        
        result = subprocess.run(
            ["ssh", f"{target_node.user}@{target_node.host}", cmd],
            capture_output=True,
            timeout=300  # 5 min timeout
        )
        
        if result.returncode != 0:
            raise RuntimeError(f"Sync failed: {result.stderr.decode()}")
```

---

## 📊 Metrics & Monitoring

### NetworkMetrics Model

```python
# watchtower/database.py

class NetworkMetric(Base):
    """Track mesh network health over time"""
    __tablename__ = "network_metrics"
    
    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    network_id = Column(Uuid(as_uuid=True), ForeignKey("node_networks.id"))
    node_a_id = Column(Uuid(as_uuid=True), ForeignKey("org_nodes.id"))
    node_b_id = Column(Uuid(as_uuid=True), ForeignKey("org_nodes.id"))
    
    # Measurements
    latency_ms = Column(Float)  # Round trip time
    bandwidth_mbps = Column(Float)  # Throughput
    packet_loss_percent = Column(Float)  # Loss rate
    
    # Timestamp
    measured_at = Column(DateTime, default=datetime.utcnow)
```

### Dashboard Queries

```
Path: /networks/{id}/metrics

Show:
- Average latency between all node pairs
- Latency heatmap (color-coded)
- Bandwidth utilization
- Packet loss trends
- Optimal routing tree visualization
- Deployment sync times (via mesh vs direct)
```

---

## ✅ Implementation Phases

### Phase 1 (Week 1-2): UI & Basic Management
- [ ] Create `/networks` page
- [ ] Network CRUD operations
- [ ] Add/remove nodes from network
- [ ] Basic network status display

### Phase 2 (Week 2-3): Measurement & Orchestration
- [ ] Implement latency measurement
- [ ] Implement bandwidth estimation
- [ ] Build routing tree algorithm
- [ ] Store metrics in database

### Phase 3 (Week 3-4): Deployment Sync
- [ ] Implement P2P artifact sync
- [ ] Use optimized routing for deployment
- [ ] Track sync progress
- [ ] Handle partial failures & retries

### Phase 4 (Month 2): Advanced Features
- [ ] Geographic load balancing
- [ ] Cost-aware routing
- [ ] Advanced failover strategies
- [ ] ML-based route learning

---

## 🎯 Success Metrics

**When complete:**
1. User creates network with 3 home PCs
2. Deploy app once to primary node
3. App auto-syncs to all PCs in ~10-30 seconds
4. Dashboard shows optimal routing tree
5. Can see latencies between all node pairs
6. Deployment chooses fastest path for each node

**Result:** Easy peer-to-peer deployment across user's entire PC network!

